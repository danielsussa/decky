import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { xtermTheme, type Mode, type Theme } from '../../../shared/themes'

// xterm's onData carries genuine keystrokes AND automatic terminal→app reports the TUI
// solicits: cursor-position/DA/DSR replies, focus in/out, and mouse tracking (motion reports
// while the pointer is over the focused terminal). Counting those as "the user typing" kept the
// echo-guard in App.tsx permanently armed on the active session, so the bot's output never
// registered and the working dot never pulsed. Treat data as input only when a real typed
// character survives stripping the escape sequences.
function isUserTyping(data: string): boolean {
  const stripped = data
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '') // DCS / PM / APC / SOS
    .replace(/\x1b\[[\d;?<>=!"' ]*[\x40-\x7e]/g, '') // CSI: mouse, CPR, DA, DSR, focus, arrows…
    .replace(/\x1bO./g, '') // SS3: F-keys / keypad
    .replace(/\x1b[\x20-\x7e]/g, '') // stray ESC + char
  return /[\x20-\x7e]/.test(stripped) || /[\r\n\t\x08\x7f]/.test(stripped)
}

const URL_REGEX = /https?:\/\/\S+/i
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/

// Walk cells outward from the clicked col to assemble the URL-token. Cell-based
// (not string-based) so wide chars like ⏺ elsewhere on the line don't shift the
// offset between buffer columns and the translated string.
function urlAtCell(term: XTerm, col: number, bufferY: number): string | null {
  const line = term.buffer.active.getLine(bufferY)
  if (!line) return null
  const charAt = (c: number): string => line.getCell(c)?.getChars() || ''
  if (!URL_CHAR.test(charAt(col))) return null
  let l = col
  let r = col
  while (l > 0 && URL_CHAR.test(charAt(l - 1))) l--
  while (r < term.cols - 1 && URL_CHAR.test(charAt(r + 1))) r++
  let token = ''
  for (let c = l; c <= r; c++) token += charAt(c)
  const match = token.match(URL_REGEX)
  return match ? match[0].replace(/[.,;:!?)]+$/, '') : null
}

interface TerminalProps {
  id: string
  cwd?: string
  /** Command to spawn (file + args). Defaults to user's shell. */
  command?: string[]
  /** When true, terminal is visible. When transitioning false → true, refits to the new container size. */
  visible?: boolean
  /** Light/dark mode — drives the xterm surface (re-applied live on change, no re-spawn). */
  mode: Mode
  /** The session's workspace theme — surface (bg/fg/cursor) uses this; ANSI follows mode only. */
  theme: Theme
  /** Called when the user types (keystroke) — lets the parent ignore echo as "bot activity". */
  onUserInput?: () => void
}

export default function Terminal({
  id,
  cwd,
  command,
  visible = true,
  mode,
  theme,
  onUserInput
}: TerminalProps): React.JSX.Element {
  const onUserInputRef = useRef(onUserInput)
  onUserInputRef.current = onUserInput
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<XTerm | null>(null)
  // Serialize command for stable useEffect deps — parent may pass new array refs
  // with identical content each render; we only want to re-spawn PTY when content changes.
  const commandKey = command ? command.join('\x00') : ''

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 10000,
      // Surface (bg/fg/cursor) follows the session's workspace hue + mode; ANSI follows the mode.
      // mode/theme aren't in this effect's deps (no re-spawn on toggle) — the effect below re-applies live.
      theme: xtermTheme(theme, mode),
      // In light mode, force a min contrast against the light bg so claude's washed-out spans
      // (inline `code`, dim/secondary text) stay legible. Off in dark mode (1 = no adjustment) so
      // the tuned dark palette renders as-is.
      minimumContrastRatio: mode === 'light' ? 4.5 : 1
    })

    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    // Open the URL as a new decky web card (same channel "nova aba de browser" uses).
    // This handler only fires when xterm's link service activates — TUIs with mouse
    // tracking (Claude, Codex) swallow the click before it gets here. The capture-phase
    // listener below is the fallback that beats mouse tracking.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.dispatchEvent(new CustomEvent('decky:web-open', { detail: uri }))
      })
    )

    term.open(host)

    // When Claude/Codex have mouse tracking on, every click is encoded as CSI and shipped
    // to the PTY before WebLinksAddon sees it. Capture-phase mousedown on the host runs
    // BEFORE xterm's own screen-element listeners, so we can intercept Cmd/Ctrl+click,
    // resolve the URL from the buffer at the clicked cell, and open it as a new web card —
    // stopping propagation so the TUI doesn't also receive the click as a mouse report.
    const onMouseDownCapture = (e: MouseEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const screen = host.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return
      const rect = screen.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const col = Math.floor(((e.clientX - rect.left) / rect.width) * term.cols)
      const row = Math.floor(((e.clientY - rect.top) / rect.height) * term.rows)
      if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return
      const url = urlAtCell(term, col, term.buffer.active.viewportY + row)
      if (!url) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      window.dispatchEvent(new CustomEvent('decky:web-open', { detail: url }))
    }
    // Mousedown is what we intercept (mouse-tracking encodes on press), but click on the
    // same gesture would still bubble — and could re-trigger WebLinksAddon's activate.
    // Swallow click too while the modifier is held, so we don't open twice.
    const onClickCapture = (e: MouseEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      e.stopPropagation()
      e.stopImmediatePropagation()
    }
    host.addEventListener('mousedown', onMouseDownCapture, true)
    host.addEventListener('click', onClickCapture, true)

    let disposed = false
    let ptyCreated = false
    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null

    unsubData = window.deck.pty.onData((msg) => {
      if (msg.id === id) term.write(msg.data)
    })
    unsubExit = window.deck.pty.onExit((msg) => {
      if (msg.id === id) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })

    const ensurePty = (): void => {
      if (ptyCreated || disposed) return
      if (host.clientWidth < 20 || term.cols < 20) return
      ptyCreated = true
      const { cols, rows } = term
      void window.deck.pty.create(id, { cols, rows, cwd, command }).then(() => {
        if (disposed) return
        term.onData((data) => {
          if (isUserTyping(data)) onUserInputRef.current?.()
          window.deck.pty.write(id, data)
        })
        term.onResize(({ cols, rows }) => window.deck.pty.resize(id, cols, rows))
        term.focus()
      })
    }

    // Retry fit + ensurePty until container is sized and xterm reports sane cols.
    // Display:none parents, slow first paint, and zero-width races all collapse here.
    const tryFit = (attempt = 0): void => {
      if (disposed) return
      const w = host.clientWidth
      const h = host.clientHeight
      if (w < 20 || h < 20) {
        if (attempt < 20) setTimeout(() => tryFit(attempt + 1), 50)
        return
      }
      try {
        fit.fit()
      } catch {
        if (attempt < 20) setTimeout(() => tryFit(attempt + 1), 50)
        return
      }
      if (term.cols < 20 && attempt < 20) {
        setTimeout(() => tryFit(attempt + 1), 50)
        return
      }
      ensurePty()
    }
    requestAnimationFrame(() => tryFit())

    // First-mount layouts (ResizableSplit applying localStorage sizes, panel resize handles,
    // ResizeObserver missing the initial paint) can leave the PTY spawned with a smaller cols
    // than the final container. Schedule a couple of "settle" refits so onResize propagates
    // the real size to the PTY shortly after first paint.
    const settleTimers = [
      setTimeout(() => {
        if (disposed) return
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      }, 100),
      setTimeout(() => {
        if (disposed) return
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      }, 300)
    ]

    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      // Ignore zero-size events (e.g. parent tab toggled to display:none) —
      // calling fit() here would shrink xterm and stale until next real resize.
      if (e.contentRect.width < 20 || e.contentRect.height < 20) return
      try {
        fit.fit()
      } catch {
        // ignore transient sizing errors
      }
      ensurePty()
    })
    ro.observe(host)

    return () => {
      disposed = true
      settleTimers.forEach(clearTimeout)
      ro.disconnect()
      host.removeEventListener('mousedown', onMouseDownCapture, true)
      host.removeEventListener('click', onClickCapture, true)
      unsubData?.()
      unsubExit?.()
      window.deck.pty.kill(id)
      term.dispose()
      fitRef.current = null
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd, commandKey])

  // Re-tint the live terminal when the mode toggles (dark↔light) — updates the xterm surface in
  // place, no PTY re-spawn. theme.id (not the object) is in deps so a parent re-render with a
  // fresh themeFor callback doesn't re-tint when the resolved theme is unchanged.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermTheme(theme, mode)
    term.options.minimumContrastRatio = mode === 'light' ? 4.5 : 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, theme.id])

  // When the tab becomes visible again, the container size changed but ResizeObserver
  // doesn't always fire (display:none → block on same dimensions). Refit a few times
  // across frames to catch the layout once it settles.
  useEffect(() => {
    if (!visible) return
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const tryRefit = (attempt = 0): void => {
      if (cancelled) return
      if (host.clientWidth < 20 || host.clientHeight < 20) {
        if (attempt < 10) setTimeout(() => tryRefit(attempt + 1), 50)
        return
      }
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
    }
    const raf = requestAnimationFrame(() => {
      tryRefit()
      // Terminal is the preferred focus target — grab it whenever this session
      // becomes visible (e.g. switching sessions via Ctrl+Up/Down).
      termRef.current?.focus()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [visible])

  return <div ref={hostRef} className="terminal-host" />
}

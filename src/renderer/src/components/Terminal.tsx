import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { themeForWorkspace, xtermTheme } from '../../../shared/themes'

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

interface TerminalProps {
  id: string
  cwd?: string
  /** Command to spawn (file + args). Defaults to user's shell. */
  command?: string[]
  /** When true, terminal is visible. When transitioning false → true, refits to the new container size. */
  visible?: boolean
  /** Called when the user types (keystroke) — lets the parent ignore echo as "bot activity". */
  onUserInput?: () => void
}

export default function Terminal({
  id,
  cwd,
  command,
  visible = true,
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
      // Surface (bg/fg/cursor) follows the session's workspace theme; ANSI palette stays fixed.
      theme: xtermTheme(themeForWorkspace(cwd))
    })

    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())

    term.open(host)

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
      unsubData?.()
      unsubExit?.()
      window.deck.pty.kill(id)
      term.dispose()
      fitRef.current = null
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd, commandKey])

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

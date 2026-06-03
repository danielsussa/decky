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

// Extensions we treat as openable file refs. Mirrors what `preview_show` accepts in dky-mcp,
// plus common code/text formats (those land in the editor card via the same preview pipeline).
const FILE_EXTS =
  'md|markdown|json|diff|patch|xlsx|csv|txt|log|yaml|yml|toml|ini|env|sql|sh|bash|zsh|py|rb|go|rs|js|jsx|ts|tsx|mjs|cjs|java|kt|kts|swift|c|h|cpp|hpp|cc|m|mm|css|scss|sass|less|html|htm|xml|svg|gql|graphql'
const REF_TAIL = `\\.(?:${FILE_EXTS})(?=[\\s,;:!?)'"\`<>]|$)`
// Path containing at least one `/` (relative or absolute). The `/`-anchor naturally rejects
// leading sentence words ("Pronto. ") because those don't contain `/`. Spaces and accents
// allowed inside — `validacao/FATURAMENTO MÉDICO MAIO.xlsx` works.
const FILE_REF_WITH_SLASH = new RegExp(
  String.raw`[/.\p{L}\p{N}~][\p{L}\p{N}\-._~/]*\/[\p{L}\p{N}\-._~/ ]*?` + REF_TAIL,
  'giu'
)
// Single-token path (no spaces, no slashes — e.g. clicking on `README.md` printed bare).
const FILE_REF_BARE = new RegExp(String.raw`[\p{L}\p{N}~][\p{L}\p{N}\-._~]*` + REF_TAIL, 'giu')

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

// Read the line as a single string + a column→string-offset map (wide chars span 2 cols but 1
// string char). Cell-based mapping keeps the click column accurate even when emoji/CJK shift
// the offsets earlier on the line.
function lineWithOffsets(
  term: XTerm,
  bufferY: number
): { text: string; colToOffset: number[] } | null {
  const line = term.buffer.active.getLine(bufferY)
  if (!line) return null
  let text = ''
  const colToOffset: number[] = new Array(term.cols).fill(-1)
  for (let c = 0; c < term.cols; c++) {
    const cell = line.getCell(c)
    if (!cell) continue
    const chars = cell.getChars()
    colToOffset[c] = text.length
    if (chars) text += chars
    else if (cell.getWidth() !== 0) text += ' '
  }
  return { text, colToOffset }
}

// Find a file-path token at the clicked cell by scanning the whole line for known-extension
// matches and picking the one that covers the click position. Spaces and accents inside the
// path are fine because the regex is anchored on the extension boundary on the right and a
// path-shaped first char on the left — sentence prefixes like "Pronto. " stop being eligible
// because "Pronto" doesn't end in a known extension.
function pathAtCell(term: XTerm, col: number, bufferY: number): string | null {
  const ln = lineWithOffsets(term, bufferY)
  if (!ln) return null
  const offset = ln.colToOffset[col]
  if (offset < 0) return null
  // Try paths-with-slash first — they're unambiguous and tolerate spaces inside the filename.
  // Then fall back to bare single-token paths if the click didn't land on a slashed path.
  for (const re of [FILE_REF_WITH_SLASH, FILE_REF_BARE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(ln.text)) != null) {
      const start = m.index
      const end = start + m[0].length
      if (offset >= start && offset < end) return m[0]
    }
  }
  return null
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
      minimumContrastRatio: mode === 'light' ? 4.5 : 1,
      // OSC 8 hyperlink handler. The agent wraps file refs as `\e]8;;decky-file:///abs/path\e\\…`
      // and emits raw URLs unwrapped; here we route both. `allowNonHttpProtocols` is what lets
      // xterm forward a non-http scheme (decky-file://) to activate without sanitizing it away.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event, text) => {
          if (text.startsWith('decky-file://')) {
            const path = decodeURIComponent(text.slice('decky-file://'.length))
            window.dispatchEvent(
              new CustomEvent('decky:open-path', { detail: { path, cwd, sessionId: id } })
            )
            return
          }
          window.dispatchEvent(new CustomEvent('decky:web-open', { detail: text }))
        }
      }
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

    // Link provider for bare file paths printed in the terminal — xterm handles hover decoration
    // (underline + pointer cursor) and click activation. The activate callback still only fires
    // outside TUI mouse-tracking; capture-phase Cmd+click below is the universal fallback.
    // Skip matches that fall INSIDE a URL (so `https://x.com/foo.html` doesn't double-match).
    const linkDispose = term.registerLinkProvider({
      provideLinks: (bufferY, callback) => {
        const ln = lineWithOffsets(term, bufferY - 1)
        if (!ln) return callback(undefined)
        const urlSpans: Array<[number, number]> = []
        const urlRe = /https?:\/\/\S+/gi
        let um: RegExpExecArray | null
        while ((um = urlRe.exec(ln.text)) != null) urlSpans.push([um.index, um.index + um[0].length])
        const inUrl = (start: number, end: number): boolean =>
          urlSpans.some(([s, e]) => start < e && end > s)
        const offsetToCol: number[] = []
        for (let c = 0; c < ln.colToOffset.length; c++) {
          const off = ln.colToOffset[c]
          if (off >= 0 && offsetToCol[off] === undefined) offsetToCol[off] = c
        }
        const out: import('@xterm/xterm').ILink[] = []
        for (const re of [FILE_REF_WITH_SLASH, FILE_REF_BARE]) {
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(ln.text)) != null) {
            const start = m.index
            const end = start + m[0].length
            if (inUrl(start, end)) continue
            const startCol = offsetToCol[start]
            // End cell is exclusive — find the col whose offset is the FIRST one >= end.
            let endCol = ln.colToOffset.length
            for (let c = startCol + 1; c < ln.colToOffset.length; c++) {
              const off = ln.colToOffset[c]
              if (off >= 0 && off >= end) {
                endCol = c
                break
              }
            }
            if (startCol == null) continue
            out.push({
              range: {
                start: { x: startCol + 1, y: bufferY },
                end: { x: endCol, y: bufferY }
              },
              text: m[0],
              activate: (_event, text) => {
                window.dispatchEvent(
                  new CustomEvent('decky:open-path', { detail: { path: text, cwd, sessionId: id } })
                )
              }
            })
          }
        }
        callback(out.length > 0 ? out : undefined)
      }
    })

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
      const bufferY = term.buffer.active.viewportY + row
      const url = urlAtCell(term, col, bufferY)
      if (url) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        window.dispatchEvent(new CustomEvent('decky:web-open', { detail: url }))
        return
      }
      // Fallback for file paths printed bare in TUI output (Claude/Codex enable mouse-tracking
      // so OSC 8 linkHandler.activate never fires inside their loop). Cell-walker uses an
      // extension heuristic — only matches tokens ending in a known extension.
      const path = pathAtCell(term, col, bufferY)
      if (path) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        window.dispatchEvent(
          new CustomEvent('decky:open-path', { detail: { path, cwd, sessionId: id } })
        )
      }
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
      linkDispose.dispose()
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

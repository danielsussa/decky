import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  id: string
  cwd?: string
  /** Command to spawn (file + args). Defaults to user's shell. */
  command?: string[]
  /** When true, terminal is visible. When transitioning false → true, refits to the new container size. */
  visible?: boolean
}

export default function Terminal({
  id,
  cwd,
  command,
  visible = true
}: TerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
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
      theme: {
        background: '#1e2330',
        foreground: '#d7dee9',
        cursor: '#8a5cf6',
        cursorAccent: '#1e2330',
        selectionBackground: '#3b4a6e',
        black: '#1e2330',
        red: '#f48771',
        green: '#b5cea8',
        yellow: '#dcdcaa',
        blue: '#9cdcfe',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#6e6e6e',
        brightRed: '#f48771',
        brightGreen: '#b5cea8',
        brightYellow: '#dcdcaa',
        brightBlue: '#9cdcfe',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff'
      }
    })

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
        term.onData((data) => window.deck.pty.write(id, data))
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
    const raf = requestAnimationFrame(() => tryRefit())
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [visible])

  return <div ref={hostRef} className="terminal-host" />
}

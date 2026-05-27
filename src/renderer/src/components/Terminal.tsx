import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  id: string
  cwd?: string
}

export default function Terminal({ id, cwd }: TerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

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
        background: '#0e0e10',
        foreground: '#e8e8ea',
        cursor: '#8a5cf6',
        cursorAccent: '#0e0e10',
        selectionBackground: '#3a3a44',
        black: '#0e0e10',
        red: '#f87171',
        green: '#86efac',
        yellow: '#fde68a',
        blue: '#93c5fd',
        magenta: '#c4b5fd',
        cyan: '#7dd3fc',
        white: '#e8e8ea',
        brightBlack: '#5a5a60',
        brightRed: '#fca5a5',
        brightGreen: '#bbf7d0',
        brightYellow: '#fef3c7',
        brightBlue: '#bfdbfe',
        brightMagenta: '#ddd6fe',
        brightCyan: '#bae6fd',
        brightWhite: '#ffffff'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())

    term.open(host)
    try {
      fit.fit()
    } catch {
      // host may not be sized yet on first paint
    }

    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null
    let disposed = false

    unsubData = window.deck.pty.onData((msg) => {
      if (msg.id === id) term.write(msg.data)
    })
    unsubExit = window.deck.pty.onExit((msg) => {
      if (msg.id === id) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })

    const { cols, rows } = term
    void window.deck.pty.create(id, { cols, rows, cwd }).then(() => {
      if (disposed) return
      term.onData((data) => window.deck.pty.write(id, data))
      term.onResize(({ cols, rows }) => window.deck.pty.resize(id, cols, rows))
      term.focus()
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore transient sizing errors
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      unsubData?.()
      unsubExit?.()
      window.deck.pty.kill(id)
      term.dispose()
    }
  }, [id, cwd])

  return <div ref={hostRef} className="terminal-host" />
}

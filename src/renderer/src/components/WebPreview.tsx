import { createElement, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink } from 'lucide-react'

// Electron <webview> isn't in React's JSX types; we render it via createElement
// and access the methods we use through this minimal interface.
interface WebviewEl extends HTMLElement {
  src: string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
}

interface WebPreviewProps {
  url: string
}

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || /^(file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s)) return `http://${s}`
  return `https://${s}`
}

export default function WebPreview({ url }: WebPreviewProps): React.JSX.Element {
  const ref = useRef<WebviewEl | null>(null)
  const [address, setAddress] = useState(url)
  const [current, setCurrent] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(true)

  // When the bot/command points this card at a new URL, navigate there.
  useEffect(() => {
    setAddress(url)
    setCurrent(url)
    const wv = ref.current
    if (wv && wv.getURL && wv.getURL() !== url) {
      void wv.loadURL(url).catch(() => {})
    }
  }, [url])

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const syncNav = (): void => {
      try {
        setCanBack(wv.canGoBack())
        setCanFwd(wv.canGoForward())
        const u = wv.getURL()
        if (u) {
          setCurrent(u)
          setAddress(u)
        }
      } catch {
        // webview not ready
      }
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const onNav = (): void => syncNav()
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [])

  const go = (raw: string): void => {
    const next = normalizeUrl(raw)
    if (!next) return
    setCurrent(next)
    void ref.current?.loadURL(next).catch(() => {})
  }

  return (
    <div className="web-preview">
      <div className="web-bar">
        <button
          type="button"
          className="web-btn"
          disabled={!canBack}
          onClick={() => ref.current?.goBack()}
          title="voltar"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="web-btn"
          disabled={!canFwd}
          onClick={() => ref.current?.goForward()}
          title="avançar"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="web-btn"
          onClick={() => ref.current?.reload()}
          title="recarregar"
        >
          <RotateCw size={14} className={loading ? 'web-spin' : undefined} />
        </button>
        <input
          className="web-url"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(address)
          }}
        />
        <button
          type="button"
          className="web-btn"
          onClick={() => window.open(current, '_blank')}
          title="abrir no navegador externo"
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {createElement('webview', {
        ref: ref as never,
        src: url,
        partition: 'persist:deckweb',
        allowpopups: 'true'
      })}
    </div>
  )
}

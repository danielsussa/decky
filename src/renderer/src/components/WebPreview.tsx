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
  executeJavaScript(code: string): Promise<unknown>
}

// Injected into every guest page on dom-ready. Without allowpopups, target=_blank and
// window.open silently do nothing — so we override window.open AND intercept clicks that
// would open a new tab (target=_blank or cmd/ctrl/middle-click), and push the URL back up
// through console.log with a known sentinel. The host listens via 'console-message' and
// dispatches a 'decky:web-open' DOM event that App.tsx turns into a new decky web card.
// console.log is the channel because guest→host IPC needs nodeIntegration or a webview
// preload script, both of which are heavier than this and have security trade-offs.
const POPUP_CAPTURE = `
(() => {
  const TOKEN = '__DECKY_POPUP__:';
  const orig = window.open;
  window.open = function(u, t) {
    if (t === '_self' && typeof orig === 'function') return orig.call(window, u, t);
    if (u) console.log(TOKEN + String(u));
    return null;
  };
  const onClick = (e) => {
    if (e.defaultPrevented) return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    const target = a.getAttribute('target');
    const newTab = target === '_blank' || e.metaKey || e.ctrlKey || e.button === 1;
    if (!newTab) return;
    e.preventDefault();
    e.stopPropagation();
    console.log(TOKEN + a.href);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
})();
`

interface WebPreviewProps {
  url: string
}

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || /^(file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  return `https://${s}`
}

export default function WebPreview({ url }: WebPreviewProps): React.JSX.Element {
  const ref = useRef<WebviewEl | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [address, setAddress] = useState(url)
  const [current, setCurrent] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(true)

  // Opened blank (e.g. a new Cmd+T tab) → focus the address bar so you can just type.
  useEffect(() => {
    if (!url) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the bot/command points this card at a new URL, navigate there. Skip loadURL on
  // empty — Electron's Chromium rejects '' as a URL and can crash the renderer.
  useEffect(() => {
    setAddress(url)
    setCurrent(url)
    const wv = ref.current
    if (!url) return
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
    // Re-inject the popup capture on every page load — each navigation gets a fresh window
    // so the previous override is gone.
    const onDomReady = (): void => {
      void wv.executeJavaScript(POPUP_CAPTURE).catch(() => {})
    }
    const onConsole = (e: Event): void => {
      const msg = (e as Event & { message?: string }).message ?? ''
      const m = /^__DECKY_POPUP__:(.+)$/.exec(msg)
      if (!m) return
      window.dispatchEvent(new CustomEvent('decky:web-open', { detail: m[1] }))
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('console-message', onConsole)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('console-message', onConsole)
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
          ref={inputRef}
          className="web-url"
          value={address}
          placeholder="digite uma URL e Enter…"
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
        // Empty src crashes Electron's webview ("ERR_INVALID_URL"); use about:blank as the
        // placeholder until the user types a URL in the address bar.
        src: url || 'about:blank',
        partition: 'persist:deckweb'
      })}
    </div>
  )
}

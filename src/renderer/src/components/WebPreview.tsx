import { createElement, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, ShieldAlert } from 'lucide-react'

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

// window.open + target="_blank" are handled natively in main (web-session.ts attaches a
// setWindowOpenHandler on every webview guest). This injection only covers the Chrome-y
// keyboard-modifier convenience: cmd/ctrl-click and middle-click on a plain link open a
// "new tab" — which in decky's world means a new web card. Without intercepting these,
// Electron just follows the link in the current view (no modifier-aware default).
const POPUP_CAPTURE = `
(() => {
  const TOKEN = '__DECKY_POPUP__:';
  const onClick = (e) => {
    if (e.defaultPrevented) return;
    const newTab = e.metaKey || e.ctrlKey || e.button === 1;
    if (!newTab) return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
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
  // Notifies the parent when the webview navigates to a real URL (typed in the address
  // bar, clicked link, history nav). The parent persists it on the card's source so a
  // remount — session switch, workspace switch, full reload — restores where we were.
  onUrlChange?: (url: string) => void
}

// Google's account login refuses embedded webviews by policy (their "disallowed_useragent" /
// "this browser may not be secure" page) — no amount of UA / Sec-CH-UA / userAgentData spoof
// gets past the embedded-topology fingerprint they detect server-side. When the current page
// is on a Google identity host, surface a banner offering to delegate to the real Chrome.
function isGoogleAuthUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return (
      u.hostname === 'accounts.google.com' ||
      u.hostname === 'accounts.youtube.com' ||
      // OAuth consent often lands on myaccount.google.com after the signin step.
      (u.hostname.endsWith('.google.com') && /\/(signin|oauth|o\/oauth2)/.test(u.pathname))
    )
  } catch {
    return false
  }
}

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || /^(file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  return `https://${s}`
}

export default function WebPreview({ url, onUrlChange }: WebPreviewProps): React.JSX.Element {
  const onUrlChangeRef = useRef(onUrlChange)
  onUrlChangeRef.current = onUrlChange
  const ref = useRef<WebviewEl | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [address, setAddress] = useState(url)
  const [current, setCurrent] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(true)
  // Tracks whether the webview has fired did-attach yet. Calling loadURL before attach
  // races with the <webview src=...> auto-load and silently fails — same trap that hit
  // the "nova aba de browser" button (the webview just stays blank).
  const attachedRef = useRef(false)
  // Latest url prop, captured so the did-attach listener (registered with [] deps) reads
  // the current value instead of the one from initial render.
  const urlRef = useRef(url)
  urlRef.current = url
  // Last URL the webview actually navigated to (typed in the address bar, or driven by the
  // url prop). Survives Electron's quirk where hiding a <webview> via display:none detaches
  // the guest — on re-show it reattaches and reloads the about:blank src, blowing away the
  // user's typed URL. We restore from this ref instead of urlRef (the original prop).
  const lastNavRef = useRef<string>(url || '')

  // Opened blank (e.g. a new Cmd+T tab) → focus the address bar so you can just type.
  useEffect(() => {
    if (!url) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the bot/command points this card at a new URL, navigate there. Before attach,
  // the did-attach handler below will pick up urlRef and navigate. After attach, we drive
  // navigation directly. Skip loadURL on empty — Chromium rejects '' as a URL.
  useEffect(() => {
    setAddress(url)
    setCurrent(url)
    if (url) lastNavRef.current = url
    if (!url) return
    const wv = ref.current
    if (!wv || !attachedRef.current) return
    if (wv.getURL && wv.getURL() !== url) {
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
        if (!u) return
        // Tab-switch quirk: hiding the <webview> via display:none detaches the guest;
        // re-showing reattaches and reloads the about:blank src. If we have a real URL
        // we'd navigated to, restore it instead of letting the address bar flip to blank.
        if (u === 'about:blank' && lastNavRef.current && lastNavRef.current !== 'about:blank') {
          void wv.loadURL(lastNavRef.current).catch(() => {})
          return
        }
        if (lastNavRef.current !== u) onUrlChangeRef.current?.(u)
        lastNavRef.current = u
        setCurrent(u)
        setAddress(u)
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
    // First attach — webview is now ready to receive loadURL. Drive the initial navigation
    // here instead of via the src attribute (which races with partition setup and silently
    // leaves the page blank).
    const onAttached = (): void => {
      attachedRef.current = true
      // Prefer the last navigated URL (typed by the user) over the original prop, so
      // a guest re-attach (display:none cycle) restores where we were, not the initial blank.
      const u = lastNavRef.current || urlRef.current
      if (u && u !== 'about:blank') void wv.loadURL(u).catch(() => {})
    }
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
    wv.addEventListener('did-attach', onAttached)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('console-message', onConsole)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('did-attach', onAttached)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('console-message', onConsole)
    }
  }, [])

  const go = (raw: string): void => {
    const next = normalizeUrl(raw)
    if (!next) return
    lastNavRef.current = next
    setCurrent(next)
    void ref.current?.loadURL(next).catch(() => {})
  }

  const googleAuthBlocked = isGoogleAuthUrl(current)

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
          onClick={() => void window.deck.app.openExternal(current)}
          title="abrir no navegador externo"
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {googleAuthBlocked && (
        <div className="web-auth-banner">
          <ShieldAlert size={14} />
          <span>
            O Google bloqueia login dentro de apps embedded. Faça o login no Chrome — o cookie do
            serviço (Gmail, Drive, etc.) volta a funcionar aqui depois.
          </span>
          <button
            type="button"
            className="web-auth-btn"
            onClick={() => void window.deck.app.openExternal(current)}
          >
            Abrir no Chrome
          </button>
        </div>
      )}
      {createElement('webview', {
        ref: ref as never,
        // Always start blank — the did-attach listener loads the real URL once the webview
        // is actually ready. Setting src to the real URL on initial render races with the
        // partition setup and tends to leave the page blank (the "nova aba" bug).
        src: 'about:blank',
        partition: 'persist:deckweb',
        // allowpopups lets window.open spawn real windows (instead of returning null); the
        // setWindowOpenHandler in main routes them — popup-windows become a BrowserWindow on
        // the same partition, tab-style opens become a new web card. Needed for OAuth flows,
        // 3-D Secure popups, and captcha challenges that depend on window.opener.
        allowpopups: 'true',
        // Removes the AutomationControlled blink feature → navigator.webdriver is false and
        // a handful of fingerprinting signals look like a regular Chrome (not a driven one).
        disableblinkfeatures: 'AutomationControlled'
      })}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink } from 'lucide-react'
import { useWebViewVisible } from '../hooks/useWebViewVisible'
import { t } from '../lib/i18n'

interface WebPreviewProps {
  // The DeckCard id this preview belongs to — also the key the main process uses to identify
  // this card's WebContentsView. Stable across re-renders of this component.
  cardId: string
  url: string
  // Notifies the parent when the view navigates to a real URL (typed in the address bar,
  // clicked link, history nav). The parent persists it on the card's source so a remount
  // (workspace switch, full reload) restores where we were.
  onUrlChange?: (url: string) => void
}

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || /^(file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  // Heurística "parece host?": sem espaços E tem ponto antes da primeira barra
  // (ex: "google.com", "foo.com/path"). Caso contrário, trata como query do Google.
  const head = s.split('/')[0]
  const looksLikeHost = !/\s/.test(s) && /\./.test(head)
  if (looksLikeHost) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

// The web card is now backed by a top-level WebContentsView in main, not a <webview> tag —
// which is what lets Google account login work (no `disallowed_useragent`). The React side
// here is just: an address-bar/nav-bar strip, a sentinel div that positions where the view
// should paint, and an effect that streams the sentinel's bounding rect to main. The page
// itself is a native overlay positioned by main from those bounds; the address bar above
// stays clickable because the view never covers it.
export default function WebPreview({
  cardId,
  url,
  onUrlChange
}: WebPreviewProps): React.JSX.Element {
  const onUrlChangeRef = useRef(onUrlChange)
  onUrlChangeRef.current = onUrlChange

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [address, setAddress] = useState(url)
  const [current, setCurrent] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(false)

  const visible = useWebViewVisible()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // Latest URL the view actually navigated to. Source of truth across the unmount/remount
  // cycle (workspace switch, session switch) — onUrlChange persists this to parent state.
  const lastNavRef = useRef<string>(url || '')

  // Empty url = "nova aba" → focus address bar for immediate typing.
  useEffect(() => {
    if (!url) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to state updates from main (loading flags, navigation history, URL/title).
  useEffect(() => {
    const off = window.deck.web.onState((msg) => {
      if (msg.cardId !== cardId) return
      setLoading(msg.loading)
      setCanBack(msg.canBack)
      setCanFwd(msg.canFwd)
      const u = msg.url || ''
      if (u && lastNavRef.current !== u) {
        lastNavRef.current = u
        onUrlChangeRef.current?.(u)
        setCurrent(u)
        setAddress(u)
      }
    })
    return off
  }, [cardId])

  // Create-or-attach the view in main. The WebContentsView's lifetime is decoupled from this
  // React component: trocar workspace unmonta o WebPreview, mas o view PERMANECE vivo em main
  // (indexado por cardId) com a página intacta — pra voltar pro workspace anterior ser idempotente
  // (sem reload, sem perder login/scroll). A destruição REAL roda só quando o usuário fecha o card
  // explicitamente (App.closeCard / handleClose), não no unmount do React.
  // No unmount aqui, só hide() — o view fica órfão (sem WebPreview rendering bounds), então
  // tem que sair de tela; senão fica pendurado com bounds antigas sobre o outro workspace.
  useEffect(() => {
    void window.deck.web.create(cardId, url)
    return () => {
      window.deck.web.hide(cardId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId])

  // When the bot/command points this card at a new URL via the prop, drive the view there.
  useEffect(() => {
    setAddress(url)
    if (!url) return
    if (lastNavRef.current === url) return
    lastNavRef.current = url
    setCurrent(url)
    window.deck.web.navigate(cardId, url)
  }, [cardId, url])

  // Geometry pump: when the sentinel changes size, ANY ancestor scrolls/resizes, or the
  // window resizes, push the new rect to main. Visibility flips run through the same code
  // path — invisible → hide() (zero-size attached), visible → setBounds(rect).
  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return

    // Dedupe: capture-mode scroll catches every scrollable ancestor in the window (incl. the
    // session terminal auto-scrolling as output streams), which fires sync ~60×/s even when
    // our rect didn't move. Repeated WebContentsView.setBounds with identical values still
    // makes the native NSView repaint on macOS — visible as flicker. Skip the IPC if nothing
    // changed since the last sync. `null` = last call was hide().
    let last: { x: number; y: number; width: number; height: number } | null = null
    let lastHidden = false

    let raf = 0
    const sync = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const el2 = canvasRef.current
        if (!el2) return
        const visuallyOff =
          typeof el2.checkVisibility === 'function'
            ? !el2.checkVisibility({ visibilityProperty: true })
            : false
        const r = el2.getBoundingClientRect()
        // A pane in visibility:hidden / display:none still has a positive rect, so the
        // visibility flag (PaneVisible/SessionVisible/Overlay) is what tells us not to paint.
        // checkVisibility() also catches edge cases (collapsed, opacity:0 hidden via subtree).
        if (!visibleRef.current || visuallyOff || r.width <= 0 || r.height <= 0) {
          if (!lastHidden) {
            lastHidden = true
            last = null
            window.deck.web.hide(cardId)
          }
          return
        }
        const next = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
        if (
          !lastHidden &&
          last &&
          last.x === next.x &&
          last.y === next.y &&
          last.width === next.width &&
          last.height === next.height
        ) {
          return
        }
        last = next
        lastHidden = false
        window.deck.web.setBounds(cardId, next)
      })
    }

    sync()

    const ro = new ResizeObserver(sync)
    ro.observe(el)
    // Pick up window resize + ancestor scroll. capture:true catches every scrolling ancestor
    // without us having to find them.
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    // Manual nudge channel — App/DeckTabs dispatch this after layout-affecting state changes
    // (split drag, tab switch, session switch, overlay open/close) so we re-measure even when
    // the sentinel's own size didn't change.
    const onLayoutTick = (): void => sync()
    window.addEventListener('decky:layout-tick', onLayoutTick)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('decky:layout-tick', onLayoutTick)
    }
  }, [cardId])

  // Visibility flag itself drives a sync. The geometry pump reads visibleRef so the
  // animation-frame closure picks up the latest value.
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('decky:layout-tick'))
  }, [visible])

  const go = (raw: string): void => {
    const next = normalizeUrl(raw)
    if (!next) return
    lastNavRef.current = next
    setCurrent(next)
    window.deck.web.navigate(cardId, next)
  }

  return (
    <div className="web-preview">
      <div className="web-bar">
        <button
          type="button"
          className="web-btn"
          disabled={!canBack}
          onClick={() => window.deck.web.back(cardId)}
          title={t('web.back')}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="web-btn"
          disabled={!canFwd}
          onClick={() => window.deck.web.forward(cardId)}
          title={t('web.forward')}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="web-btn"
          onClick={() => window.deck.web.reload(cardId)}
          title={t('web.reload')}
        >
          <RotateCw size={14} className={loading ? 'web-spin' : undefined} />
        </button>
        <input
          ref={inputRef}
          className="web-url"
          value={address}
          placeholder={t('web.urlPlaceholder')}
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
          title={t('web.openExternal')}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div ref={canvasRef} className="web-canvas" />
    </div>
  )
}

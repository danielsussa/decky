import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, Bug } from 'lucide-react'
import { useWebViewVisible } from '../hooks/useWebViewVisible'
import { t } from '../lib/i18n'

interface WebPreviewProps {
  // The DeckCard id this preview belongs to — also the key the main process uses to identify
  // this card's WebContentsView. Stable across re-renders of this component.
  cardId: string
  url: string
  // Workspace cwd that owns this card. Passed to main on create so the history subsystem
  // can tag each visit with the right workspace_id. Null when unknown (system panels etc).
  workspaceCwd?: string | null
  // Notifies the parent of changes to navigation metadata (URL/title/favicon). The parent
  // persists this on the card's source so a remount (workspace switch, full reload) and the
  // tab strip (which shows title+favicon) stay in sync without re-driving the page.
  onMetaChange?: (meta: { url?: string; title?: string; favicon?: string | null }) => void
  // Pretty label to show in the address bar when blurred AND the current URL still matches
  // the initial `url` prop. Used by HtmlPreview to hide the noisy `http://127.0.0.1:<port>/`
  // prefix and show only the file's basename. On focus the real URL reappears so the user can
  // still edit/navigate.
  displayAlias?: string
}

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || /^(file|about|data|card|decky-asset):/i.test(s)) return s
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
  workspaceCwd,
  onMetaChange,
  displayAlias
}: WebPreviewProps): React.JSX.Element {
  const onMetaChangeRef = useRef(onMetaChange)
  onMetaChangeRef.current = onMetaChange

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [address, setAddress] = useState(url)
  const [current, setCurrent] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [favicon, setFavicon] = useState<string | null>(null)
  // Favicons que falharam ao carregar (URL inválida, 404, CORS) — não tenta de novo no mesmo
  // mount, cai pro Globe. Reset implícito no remount do card.
  const [faviconFailed, setFaviconFailed] = useState<Set<string>>(new Set())
  // Address-bar autocomplete: sugestões vindas do histórico (workspace atual).
  // showSuggest é controlado por foco do input + presença de resultados.
  type Suggestion = {
    url: string
    title: string | null
    favicon: string | null
    hits: number
    last_visited: number
  }
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  // Address bar focus state — controls quando o `displayAlias` (basename pra html cards)
  // toma lugar do `address` real. Focado = mostra a URL real (editável); blurred com
  // alias definido E current === url (não navegou pra fora) = mostra o basename.
  const [isFocused, setIsFocused] = useState(false)
  // Trava: ao Enter/click numa sugestão, navega — mas a sequência de setAddress + go
  // re-disparam o fetcher, que reabriria o popover por cima da página recém-aberta. Ref
  // segura o show até o input perder foco ou a navegação consolidar.
  const justCommittedRef = useRef(false)
  // Popover ref + altura medida: WebContentsView é overlay OS-native acima do DOM, então
  // o popover renderizado abaixo da bar ficaria atrás do canvas. Pra liberar a área,
  // encolhemos os bounds do view nativo subtraindo a altura do popover do topo do canvas.
  // A altura mora num ref pra que o geometry pump leia sem re-criar o efeito a cada render.
  const suggestRef = useRef<HTMLUListElement | null>(null)
  const popoverHeightRef = useRef(0)

  const visible = useWebViewVisible()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // Latest URL/title/favicon the view actually exposed. Source of truth across the
  // unmount/remount cycle (workspace switch, session switch) — onMetaChange persists this to
  // parent state. Deduped here so we don't churn React state on every web:state event (which
  // fires for loading flag changes too).
  const lastNavRef = useRef<string>(url || '')
  const lastTitleRef = useRef<string>('')
  const lastFaviconRef = useRef<string | null>(null)

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
      setFavicon(msg.favicon)
      const u = msg.url || ''
      const meta: { url?: string; title?: string; favicon?: string | null } = {}
      if (u && lastNavRef.current !== u) {
        lastNavRef.current = u
        meta.url = u
        setCurrent(u)
        setAddress(u)
      }
      if (lastTitleRef.current !== msg.title) {
        lastTitleRef.current = msg.title
        meta.title = msg.title
      }
      if (lastFaviconRef.current !== msg.favicon) {
        lastFaviconRef.current = msg.favicon
        meta.favicon = msg.favicon
      }
      if (Object.keys(meta).length > 0) onMetaChangeRef.current?.(meta)
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
  // useLayoutEffect (não useEffect) pra garantir que o create() seja enfileirado ANTES do rAF do
  // geometry pump abaixo — useEffect roda depois do paint, mas o rAF do pump dispara antes do
  // useEffect, então um web:set-bounds chegaria no main antes do web:create e seria dropado
  // ("NO ENTRY") — card nasce em branco até um layout-tick subsequente (troca de sessão p.ex.).
  useLayoutEffect(() => {
    void window.deck.web.create(cardId, url, workspaceCwd ?? null)
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

  // Address-bar autocomplete: busca sugestões do histórico (workspace atual) com debounce.
  // Trigger: address muda E o popover está habilitado (showSuggest=true → input focado).
  // Empty query devolve top frecência geral (vira "histórico recente rankeado" no foco vazio).
  // Skip quando address === current (estamos só mostrando a URL da página, não digitando)
  // ou quando o usuário acabou de selecionar (justCommittedRef).
  useEffect(() => {
    if (!showSuggest) return
    if (justCommittedRef.current) return
    // Mínimo 2 chars pra abrir lista — evita popover no foco vazio / 1 letra (ruído).
    if (address.trim().length < 2) {
      setSuggestions([])
      setHighlight(-1)
      return
    }
    // Pula quando o input mostra a URL da página atual (focou sem digitar).
    if (address === current) return
    let cancelled = false
    const handle = setTimeout(() => {
      void window.deck.history
        .suggest(workspaceCwd ?? null, address, 8)
        .then((rows) => {
          if (cancelled) return
          setSuggestions(rows)
          setHighlight(rows.length > 0 ? 0 : -1)
        })
        .catch(() => {
          if (!cancelled) setSuggestions([])
        })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [address, current, showSuggest, workspaceCwd])

  // Mede o popover (quando aberto) e mantém popoverHeightRef em dia. ResizeObserver pega
  // mudanças de altura conforme suggestions[] cresce/encolhe. Tick dispara o pump pra ele
  // re-aplicar os bounds com a área subtraída.
  useLayoutEffect(() => {
    const open = showSuggest && suggestions.length > 0
    if (!open) {
      if (popoverHeightRef.current !== 0) {
        popoverHeightRef.current = 0
        window.dispatchEvent(new Event('decky:layout-tick'))
      }
      return
    }
    const el = suggestRef.current
    if (!el) return
    const measure = (): void => {
      const h = el.getBoundingClientRect().height
      if (h !== popoverHeightRef.current) {
        popoverHeightRef.current = h
        window.dispatchEvent(new Event('decky:layout-tick'))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showSuggest, suggestions.length])

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
        // Popover de autocomplete vive entre a bar e o topo do canvas (top: calc(100% + 4px)
        // do input wrap). Subtrai (popH + 4) do topo do view nativo pra ele não cobrir a
        // lista. Quando fechado, popoverHeightRef === 0 → sem efeito.
        const popH = popoverHeightRef.current
        const skip = popH > 0 ? Math.min(popH + 4, Math.round(r.height)) : 0
        const next = {
          x: Math.round(r.left),
          y: Math.round(r.top) + skip,
          width: Math.round(r.width),
          height: Math.round(r.height) - skip
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
    setAddress(next)
    // Push the URL up to App.tsx NOW (synchronously) — onState IPC echoes back later but its
    // dedupe guard (lastNavRef.current !== u) silently swallows the URL because we just set
    // lastNavRef above. Without this, the source's url never updates and disk persistence
    // never sees the new URL → restart loses it.
    onMetaChangeRef.current?.({ url: next })
    window.deck.web.navigate(cardId, next)
    // Fecha popover + segura abertura imediata até o blur (ou nova digitação real).
    justCommittedRef.current = true
    setShowSuggest(false)
    setSuggestions([])
    setHighlight(-1)
    inputRef.current?.blur()
  }

  const commitSuggestion = (s: Suggestion): void => {
    go(s.url)
  }

  const onAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setHighlight((h) => (h + 1) % suggestions.length)
      return
    }
    if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setAddress(current)
      setShowSuggest(false)
      setSuggestions([])
      setHighlight(-1)
      inputRef.current?.select()
      return
    }
    if (e.key === 'Enter') {
      if (showSuggest && highlight >= 0 && suggestions[highlight]) {
        e.preventDefault()
        commitSuggestion(suggestions[highlight])
        return
      }
      go(address)
    }
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
        <div className="web-favicon" aria-hidden>
          {favicon && !faviconFailed.has(favicon) ? (
            <img
              src={favicon}
              alt=""
              onError={() =>
                setFaviconFailed((prev) => {
                  if (prev.has(favicon)) return prev
                  const next = new Set(prev)
                  next.add(favicon)
                  return next
                })
              }
            />
          ) : (
            <Globe size={13} />
          )}
        </div>
        <div className="web-url-wrap">
          <input
            ref={inputRef}
            className="web-url"
            value={!isFocused && displayAlias && current === url ? displayAlias : address}
            placeholder={t('web.urlPlaceholder')}
            spellCheck={false}
            onChange={(e) => {
              justCommittedRef.current = false
              setAddress(e.target.value)
              setShowSuggest(true)
            }}
            onFocus={() => {
              justCommittedRef.current = false
              setIsFocused(true)
              setShowSuggest(true)
              // Select-all no foco — comportamento padrão de URL bar (Chrome/Safari).
              inputRef.current?.select()
            }}
            // Pequeno timeout pra não fechar o popover antes do click no item registrar.
            onBlur={() => {
              setIsFocused(false)
              window.setTimeout(() => {
                setShowSuggest(false)
                setHighlight(-1)
              }, 120)
            }}
            onKeyDown={onAddressKeyDown}
          />
          {showSuggest && suggestions.length > 0 && (
            <ul className="web-suggest" role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.url}
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? 'web-suggest-item is-active' : 'web-suggest-item'}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    // mousedown (não click) pra disparar antes do blur do input fechar a lista.
                    e.preventDefault()
                    commitSuggestion(s)
                  }}
                >
                  <div className="web-suggest-icon" aria-hidden>
                    {s.favicon ? (
                      <img src={s.favicon} alt="" onError={(e) => e.currentTarget.remove()} />
                    ) : (
                      <Globe size={12} />
                    )}
                  </div>
                  <div className="web-suggest-text">
                    <div className="web-suggest-url">{s.url}</div>
                    {s.title ? <div className="web-suggest-title">{s.title}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="web-btn"
          onClick={() => window.deck.web.openDevTools(cardId)}
          title={t('web.devtools')}
        >
          <Bug size={14} />
        </button>
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

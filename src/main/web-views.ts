import {
  WebContentsView,
  BrowserWindow,
  ipcMain,
  Menu,
  clipboard,
  type WebContents
} from 'electron'
import { WEB_PARTITION } from './web-session'
import { diag } from '@decky/server'
import {
  openVisit as historyOpenVisit,
  closeVisit as historyCloseVisit,
  patchTitle as historyPatchTitle,
  patchFavicon as historyPatchFavicon,
  setVisible as historySetVisible,
  getOpenVisitUrl as historyGetOpenVisitUrl
} from '@decky/server'

// Tracing the create/destroy/bounds lifecycle per card (decky-startup.log). Logs only
// structural events (first attach, zero-size hide, missing-entry drops, create/destroy)
// — the geometry pump dedupes identical bounds, so steady state stays quiet.
// Opt-out: DECKY_NO_WEB_LIFECYCLE_DIAG=1.
const LIFECYCLE_DIAG = !process.env.DECKY_NO_WEB_LIFECYCLE_DIAG
const wlog = (msg: string): void => {
  if (LIFECYCLE_DIAG) diag(`[web-views] ${msg}`)
}

// Enquanto o usuário digita num campo editável do renderer (terminal, address bar, form…), NENHUM
// card pode roubar o foco de OS. O renderer manda um ping a cada tecla (app:typing-ping); se um
// WebContentsView ganhar o foco logo em seguida (site faz el.focus(), autofocus, vídeo, anúncio,
// re-render…), o evento 'focus' do WebContents devolve o foco na hora. Usamos RECÊNCIA, não um flag:
// clicar num card não gera ping, então clique do usuário num card foca normal — só o roubo "do nada"
// enquanto se digita é revertido.
// Cor de fundo da WebContentsView por scheme: cards card:// querem transparente (mostram o tema
// do shell atrás); páginas web externas querem branco (canvas base do navegador), senão páginas
// que não pintam o próprio bg em toda a área (ex: Stripe checkout) deixam o wallpaper vazar.
function bgForUrl(url: string | undefined | null): string {
  return url && url.startsWith('card://') ? '#00000000' : '#ffffff'
}

const TYPING_RECENCY_MS = 1200
let lastRendererTypingTs = 0
export function noteRendererTyping(): void {
  // Date.now() é permitido em app code (a restrição é só pra scripts de workflow).
  lastRendererTypingTs = Date.now()
}
function rendererTypingRecently(): boolean {
  return Date.now() - lastRendererTypingTs < TYPING_RECENCY_MS
}

// One WebContentsView per web card. Top-level webContents (not a <webview> tag), which Google's
// account login accepts — no `disallowed_useragent`. The view is a native overlay positioned
// over the React shell; the shell's address bar lives ABOVE this overlay in DOM order, so the
// React UI can stay clickable while the view fills only the page area below it.
//
// Lifecycle: created when a web card mounts; destroyed when it unmounts. Show/hide is
// setBounds — zero-size bounds = hidden but still attached (page state survives session/tab
// switches and overlay open/close). Detach (removeChildView) is reserved for destroy.

interface ViewState {
  view: WebContentsView
  initialUrl: string
  attached: boolean
  // True quando o handoff está dirigindo este card. Persistido pra reinjeção no dom-ready
  // (navegação limpa o blocker do DOM).
  controlling: boolean
  // Favicon URL captado de page-favicon-updated; null entre navegações pra site diferente.
  // Chromium dispara o evento com várias URLs ordenadas (resoluções, ico/png) — pegamos a
  // primeira, que costuma ser a de maior fidelidade.
  favicon: string | null
  // Workspace cwd que owna este card. Tag pro histórico (workspace_id é resolvido a partir
  // disso em getWorkspaceMeta). Null quando o renderer não passou (gracefully skips capture).
  workspaceCwd: string | null
  // URL que precisa ser carregada no primeiro attach com bounds não-zero. O embed nativo de PDF
  // do Chromium se inicializa com o tamanho do view no momento do load e não se re-layouta
  // depois — se a gente chamar loadURL antes do view ter dimensão, o PDF nasce em branco e só
  // acorda num next paint (ex: ciclo hide/show ao trocar workspace). Adiar o load até o
  // primeiro setBounds não-zero corrige isso pra PDFs sem afetar páginas HTML.
  pendingUrl: string | null
  // URL que falhou (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED, etc) e está sendo substituída
  // pela página de erro interna (data: URL). Mantemos pra (a) snapshot devolver a URL/título
  // "lógicos" no lugar do data: feio na address bar, (b) reload re-tentar a URL real em vez de
  // recarregar a página de erro, (c) limpar quando uma nova navegação bem-sucedida acontecer.
  failedUrl: string | null
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

type EmitState = (cardId: string) => void

class WebViewsManager {
  private views = new Map<string, ViewState>()
  private getWin: () => BrowserWindow | null
  // HTTP Basic/Digest auth: o Electron NÃO abre o popup de credenciais sozinho (o Chrome.exe
  // abre) — sem um listener de 'login' + preventDefault, ele cancela toda autenticação e a
  // página recebe 401 em branco. Estes mapas dão memória de sessão estilo browser:
  //  - authCache: realm-key → credencial aceita, pra reusar em subresources do mesmo realm sem
  //    repopupar a cada imagem/fetch protegido.
  //  - authAttempts: URL do request → quantas vezes o 'login' disparou pra ELE. >1 significa que
  //    a credencial (lembrada ou digitada) acabou de ser recusada → não reusa a do cache, abre o
  //    popup de novo. Limpo no did-navigate (nav top-level nova = começa do zero).
  private authCache = new Map<string, { username: string; password: string }>()
  private authAttempts = new Map<string, number>()

  constructor(getWin: () => BrowserWindow | null) {
    this.getWin = getWin
  }

  has(cardId: string): boolean {
    return this.views.has(cardId)
  }

  // The webContents driven by a card — exposed so the popup router can install the
  // setWindowOpenHandler exactly like it does for <webview> guests.
  webContentsFor(cardId: string): WebContents | null {
    return this.views.get(cardId)?.view.webContents ?? null
  }

  webContentsIds(): number[] {
    return Array.from(this.views.values(), (s) => s.view.webContents.id)
  }

  // Reverse lookup: dado um WebContents, devolve o cardId que o tem. Usado pelo handoff-backend
  // pra saber QUAL card está sob controle quando o runtime dispara onActivity.
  cardIdFor(wc: WebContents): string | null {
    const id = wc.id
    for (const [cardId, s] of this.views) {
      if (s.view.webContents.id === id) return cardId
    }
    return null
  }

  create(cardId: string, initialUrl: string, workspaceCwd: string | null, emit: EmitState): void {
    if (this.views.has(cardId)) {
      // Already created — if the URL changed (rehydrate path), navigate; otherwise no-op.
      const s = this.views.get(cardId)!
      wlog(`create ${cardId} → existing entry (attached=${s.attached}), url=${initialUrl || '<empty>'}`)
      // Always refresh the workspace tag — a card may have been created without one (older
      // path) and later receive it on rehydrate.
      if (workspaceCwd && workspaceCwd !== s.workspaceCwd) s.workspaceCwd = workspaceCwd
      const willNavigate =
        !!initialUrl && initialUrl !== s.initialUrl && initialUrl !== 'about:blank'
      if (initialUrl && initialUrl !== s.initialUrl) {
        s.initialUrl = initialUrl
        if (initialUrl !== 'about:blank') {
          // Se o primeiro load ainda está pendente (view ainda sem bounds), só troca a URL
          // que será carregada quando setBounds fizer o flush. Sem isso, carregaríamos aqui
          // a URL nova e logo em seguida o setBounds re-carregaria a antiga (pendingUrl).
          if (s.pendingUrl) {
            s.pendingUrl = initialUrl
          } else {
            void s.view.webContents.loadURL(initialUrl).catch(() => {})
          }
        }
      }
      // Bootstrap pra cards já abertos: se NÃO vai navegar (não tem URL nova) e ainda não há
      // visit aberta pra URL atual, abre uma agora com URL/título/favicon que o webContents
      // já tem. Cobre o cenário "card vivo de antes do feature OU de antes do workspaceCwd
      // estar plumbed" — sem isso, esses cards só entram no histórico após a próxima nav.
      if (!willNavigate && s.workspaceCwd) {
        try {
          const liveUrl = s.view.webContents.getURL()
          if (
            liveUrl &&
            liveUrl !== 'about:blank' &&
            !liveUrl.startsWith('data:') &&
            historyGetOpenVisitUrl(cardId) !== liveUrl
          ) {
            historyOpenVisit(cardId, liveUrl, s.workspaceCwd, 'rehydrate', {
              title: s.view.webContents.getTitle() || null,
              favicon: s.favicon
            })
          }
        } catch (err) {
          console.error('[history] bootstrap openVisit failed:', err)
        }
      }
      return
    }
    wlog(`create ${cardId} → new view, url=${initialUrl || '<empty>'}`)
    const view = new WebContentsView({
      webPreferences: {
        partition: WEB_PARTITION,
        sandbox: true,
        nodeIntegration: false,
        // Deliberately OFF: the stealth preload (registered on this partition's session via
        // setupWebSession) must patch navigator.userAgentData in the page's MAIN world so
        // Google's client-side getHighEntropyValues() check sees the "Google Chrome" brand.
        // With contextIsolation on, the preload runs in an isolated world and the page keeps
        // bare Chromium. The guest is still sandboxed with no Node — dropping isolation only
        // affects how the preload's spoofs reach the page, not what the page can do.
        contextIsolation: false,
        // webSecurity OFF — cards card://ws-XXX/foo.html precisam embeber recursos same-origin
        // (img ./asset.png, iframe http://127.0.0.1:6789 do Live View). Default `true` aplica
        // CSP estilo navegador que bloqueia cross-scheme (card:// → http://). Sem Node + sandbox
        // continua isolando o renderer; o trade-off é exatamente o que cards precisam: HTML
        // arbitrário com assets locais + iframes pra serviços do host.
        // MAS: só pros cards card://. Pra web cards REAIS (sites externos) webSecurity TEM que
        // ficar ON — com ela OFF o same-origin/SameSite/origin-de-postMessage ficam bagunçados e
        // anti-bots cross-origin quebram: o Cloudflare Turnstile (e reCAPTCHA/hCaptcha) gira pra
        // sempre sem nunca emitir token. Web cards começam com http(s):// ou vazio (tab nova);
        // só os content cards começam com card://. Escopa pelo scheme da URL inicial.
        webSecurity: !(initialUrl || '').startsWith('card://')
      }
    })
    // Fundo: cards card:// usam body transparente p/ deixar o shell da app (bg-0 + paisagem do
    // tema) aparecer atrás → transparente. Sites externos NEM SEMPRE pintam fundo opaco em toda
    // a área (ex: Stripe checkout deixa a coluna esquerda sem bg, contando com o canvas branco do
    // navegador); se a view fosse transparente, o wallpaper do app vazaria por trás. Por isso:
    // card:// → transparente, http(s)/resto → branco (igual ao canvas base do Chrome). O scheme
    // real é reconfirmado no did-navigate; aqui usamos o initialUrl só p/ evitar flash inicial.
    view.setBackgroundColor(bgForUrl(initialUrl))
    const wc = view.webContents
    const state: ViewState = {
      view,
      initialUrl,
      attached: false,
      controlling: false,
      favicon: null,
      workspaceCwd,
      pendingUrl: initialUrl && initialUrl !== 'about:blank' ? initialUrl : null,
      failedUrl: null
    }
    this.views.set(cardId, state)
    this.wireEvents(cardId, wc, emit)
  }

  destroy(cardId: string): void {
    const s = this.views.get(cardId)
    if (!s) {
      wlog(`destroy ${cardId} → no entry`)
      return
    }
    wlog(`destroy ${cardId} (attached=${s.attached})`)
    historyCloseVisit(cardId)
    const win = this.getWin()
    if (win && !win.isDestroyed() && s.attached) {
      try {
        win.contentView.removeChildView(s.view)
      } catch {
        // already detached
      }
    }
    try {
      s.view.webContents.close()
    } catch {
      // already gone
    }
    this.views.delete(cardId)
  }

  // Position + show. First setBounds attaches; subsequent ones just reposition. A bounds with
  // zero width or height is the "hidden" state — keeps the view attached so page state stays
  // alive across the hide/show cycle (tab switch, overlay open/close).
  setBounds(cardId: string, b: Bounds): void {
    const s = this.views.get(cardId)
    if (!s) {
      wlog(`setBounds ${cardId} ${b.width}x${b.height}@${b.x},${b.y} → NO ENTRY (dropped)`)
      return
    }
    const win = this.getWin()
    if (!win || win.isDestroyed()) return
    const wasAttached = s.attached
    if (!s.attached) {
      try {
        win.contentView.addChildView(s.view)
        s.attached = true
      } catch {
        // already attached
      }
    }
    const rounded = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height))
    }
    try {
      s.view.setBounds(rounded)
      if (!wasAttached) wlog(`setBounds ${cardId} ${rounded.width}x${rounded.height}@${rounded.x},${rounded.y} (attached now)`)
      else if (rounded.width === 0 || rounded.height === 0) wlog(`setBounds ${cardId} ${rounded.width}x${rounded.height}@${rounded.x},${rounded.y} (zero-size = hidden)`)
    } catch {
      // view may be tearing down
    }
    // Load adiada: dispara o loadURL no primeiro setBounds com dimensão real. Garante que o
    // embed nativo de PDF veja o view com size > 0 no momento da inicialização (sem isso o
    // PDF nasce em branco — ver pendingUrl em ViewState).
    if (s.pendingUrl && rounded.width > 0 && rounded.height > 0) {
      const url = s.pendingUrl
      s.pendingUrl = null
      this.guardLoadFocus(s.view.webContents)
      void s.view.webContents.loadURL(url).catch(() => {})
    }
    // Dwell tracking: non-zero bounds = visível, zero = escondido. O capture.ts ignora flips
    // idempotentes (não acumula tempo duplicado se o bounds só mexeu de posição).
    historySetVisible(cardId, rounded.width > 0 && rounded.height > 0)
  }

  // Cheap hide: setBounds(0,0,0,0). The view stays in the contentView tree (page survives) but
  // takes no screen space. Use this on tab switch / overlay open instead of destroy.
  hide(cardId: string): void {
    wlog(`hide ${cardId}`)
    this.setBounds(cardId, { x: 0, y: 0, width: 0, height: 0 })
  }

  navigate(cardId: string, url: string): void {
    const s = this.views.get(cardId)
    if (!s) return
    s.failedUrl = null
    this.guardLoadFocus(s.view.webContents)
    void s.view.webContents.loadURL(url).catch(() => {})
  }

  // Open Chrome DevTools on the card's page (not the decky shell). `mode: 'detach'` puts it
  // in a separate window so the geometry pump's bounds aren't fighting a docked panel inside
  // the WebContentsView. Toggles: if devtools are already open for this view, close them.
  toggleDevTools(cardId: string): void {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  back(cardId: string): void {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(cardId: string): void {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  // Qualquer (re)carga de uma WebContentsView faz o Chromium dar o foco de OS pra view nativa —
  // roubando o foco do renderer "do nada" enquanto o usuário pode estar digitando no terminal. Isso
  // vale pro live-reload (reload), pra navegação em background (navigate) E pra PRIMEIRA carga de um
  // card recém-criado (setBounds dispara o loadURL adiado) — ex: o agente faz preview_show/monta um
  // card enquanto o usuário digita. Chamar ANTES de disparar o load.
  //
  // Só devolvemos o foco se o RENDERER (terminal/UI) o tinha quando a carga começou: se estava na
  // própria view, em OUTRO card, ou noutro app, não mexe. E não basta `win.webContents.focus()` —
  // o Chromium devolve o foco de OS pra janela mas o <textarea> do xterm fica blur (activeElement
  // vira o body) e o que o usuário digita não cai em lugar nenhum. Por isso, além de focar a janela,
  // mandamos um IPC pro renderer recolocar o foco no elemento certo (o terminal ativo).
  private guardLoadFocus(wc: WebContents): void {
    const win = this.getWin()
    const rendererHadFocus =
      !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.isFocused()
    if (!rendererHadFocus) return
    wc.once('did-stop-loading', () => {
      const w = this.getWin()
      if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return
      if (!w.webContents.isFocused()) w.webContents.focus()
      w.webContents.send('app:focus-stolen-back')
    })
  }

  reload(cardId: string): void {
    const s = this.views.get(cardId)
    if (!s) return
    const wc = s.view.webContents
    this.guardLoadFocus(wc)
    // Reload em cima da página de erro recarregaria o próprio data: URL (no-op visual). O que
    // o usuário quer é tentar de novo a URL que falhou — re-disparamos a navegação real.
    if (s.failedUrl) {
      const url = s.failedUrl
      s.failedUrl = null
      void wc.loadURL(url).catch(() => {})
      return
    }
    wc.reload()
  }

  stop(cardId: string): void {
    this.views.get(cardId)?.view.webContents.stop()
  }

  executeJavaScript(cardId: string, code: string): void {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    void wc.executeJavaScript(code).catch(() => {})
  }

  // Incremental live patch — append one widget (from its spec) or pop the last n, by driving the
  // card's __decky*Widget runtime hooks. No document reload, so building a card up doesn't flicker.
  // The `&&` guards make it a no-op on a card whose bridge predates these hooks (it reconciles on
  // the next full reload). JSON.stringify is JS-literal-safe except U+2028/2029, which we escape.
  patchCard(
    cardId: string,
    patch: { op: string; type?: string; id?: string; spec?: unknown; n?: number }
  ): void {
    const lit = (v: unknown): string =>
      JSON.stringify(v ?? null)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
    // If the runtime hook isn't there yet (card still loading, or a bridge predating these hooks),
    // fall back to a full reload — the manifest on disk already has the change, so the reloaded page
    // renders it correctly. Steady state (card ready) takes the in-place path: no reload, no flicker.
    if (patch.op === 'append') {
      this.executeJavaScript(
        cardId,
        `window.__deckyAppendWidget ? window.__deckyAppendWidget(${lit(patch.type || '')}, ${lit(
          patch.id || ''
        )}, ${lit(patch.spec || {})}) : location.reload()`
      )
    } else if (patch.op === 'pop') {
      this.executeJavaScript(
        cardId,
        `window.__deckyPopWidget ? window.__deckyPopWidget(${Number(patch.n) || 1}) : location.reload()`
      )
    }
  }

  // Liga/desliga o estado "controlado pelo handoff" no card:
  //  - injeta o BLOCKER no DOM da página (engole input REAL — isTrusted=true; sintético do
  //    handoff é isTrusted=false e passa direto),
  //  - emite IPC pro renderer animar a borda + encolher os bounds.
  // Idempotente. Reinjeção no dom-ready acontece se ainda estiver controlado quando a página
  // navegar.
  isControlling(cardId: string): boolean {
    return this.views.get(cardId)?.controlling ?? false
  }

  setControlling(cardId: string, on: boolean): void {
    const s = this.views.get(cardId)
    if (!s) return
    if (s.controlling === on) return
    s.controlling = on
    const wc = s.view.webContents
    if (on) {
      void wc.executeJavaScript(INSTALL_INPUT_BLOCKER).catch(() => {})
    } else {
      void wc.executeJavaScript(UNINSTALL_INPUT_BLOCKER).catch(() => {})
    }
    const win = this.getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send('web:controlling', { cardId, controlling: on })
    }
  }

  destroyAll(): void {
    for (const id of Array.from(this.views.keys())) this.destroy(id)
  }

  private wireEvents(cardId: string, wc: WebContents, emit: EmitState): void {
    const fire = (): void => emit(cardId)
    wc.on('did-start-loading', fire)
    wc.on('did-stop-loading', fire)
    // Anti-roubo de foco: se este card ganhar o foco de OS enquanto o usuário está digitando no
    // renderer, devolve na hora. Cobre QUALQUER causa (load, el.focus() do site, autofocus, vídeo,
    // anúncio) num único ponto — o evento 'focus' do WebContents dispara em toda troca de foco entre
    // views da mesma janela. Recência (TYPING_RECENCY_MS) não briga com cliques do usuário no card.
    wc.on('focus', () => {
      if (!rendererTypingRecently()) return
      const win = this.getWin()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.focus()
      win.webContents.send('app:focus-stolen-back')
    })
    // HTTP auth (401 Basic/Digest, ou 407 de proxy). Sem este handler o Electron cancela a
    // autenticação e a página fica em branco/erro — diferente do Chrome, que abre o popup de
    // login. Replicamos esse popup com um modal próprio e devolvemos as credenciais via callback.
    wc.on('login', (event, details, authInfo, callback) => {
      event.preventDefault()
      const realmKey = `${authInfo.isProxy ? 'proxy' : `${authInfo.host}:${authInfo.port}`}|${authInfo.scheme}|${authInfo.realm}`
      const reqUrl = details.url || ''
      const attempt = (this.authAttempts.get(reqUrl) ?? 0) + 1
      this.authAttempts.set(reqUrl, attempt)
      const cached = this.authCache.get(realmKey)
      // Credencial lembrada nesta sessão e ainda não recusada pra ESTE request → tenta calado.
      if (cached && attempt === 1) {
        callback(cached.username, cached.password)
        return
      }
      // attempt > 1 = a credencial acabou de ser recusada (re-challenge) → não reusa o cache.
      if (attempt > 1) this.authCache.delete(realmKey)
      void this.promptForCredentials(authInfo).then((creds) => {
        if (creds) {
          this.authCache.set(realmKey, creds)
          callback(creds.username, creds.password)
        } else {
          // Cancelado → limpa o contador e cancela a auth (página recebe o 401 do servidor).
          this.authAttempts.delete(reqUrl)
          callback()
        }
      })
    })
    // Intercept clicks on links INSIDE a card:// page — instead of navigating the embedded
    // WebContentsView (which would replace e.g. the tags-index with the clicked card), tell
    // the renderer to open the target as a NEW decky tab (with de-dup against existing tabs).
    wc.on('will-navigate', (e, url) => {
      try {
        const target = new URL(url)
        if (target.protocol !== 'card:') return
        const current = wc.getURL()
        const currentParsed = current ? new URL(current) : null
        if (
          currentParsed &&
          currentParsed.protocol === 'card:' &&
          (currentParsed.hostname !== target.hostname || currentParsed.pathname !== target.pathname)
        ) {
          e.preventDefault()
          this.getWin()?.webContents.send('card:open-tab', { url })
        }
      } catch {
        // not a parseable URL — let the default navigation behavior decide
      }
    })
    wc.on('did-navigate', (_e, url) => {
      // Nav top-level commitou → qualquer auth em voo foi aceita. Zera o contador de tentativas
      // pra um futuro re-challenge real (sessão expirada) voltar a popupar em vez de reusar.
      this.authAttempts.clear()
      const s = this.views.get(cardId)
      // Navegação pra página de erro interna (data: URL carregada pelo did-fail-load handler).
      // Não mexe em favicon, não loga no histórico, e mantém s.failedUrl ativo pra snapshot
      // continuar reportando a URL original na address bar.
      if (url.startsWith('data:')) {
        fire()
        return
      }
      // Reconfirma o fundo pelo scheme real: card:// transparente (tema do shell atrás), web branco
      // (senão páginas que não pintam o próprio bg em toda área deixam o wallpaper da app vazar).
      try {
        s?.view.setBackgroundColor(bgForUrl(url))
      } catch {
        // view já destruída
      }
      // Top-level navigation pra outra origem → o favicon atual não vale mais. Limpa pra
      // não exibir o ícone do site anterior até o do novo chegar.
      if (s) {
        s.failedUrl = null
        const prev = s.favicon
        try {
          const prevHost = prev ? new URL(prev).host : null
          const nextHost = new URL(url).host
          if (prevHost !== nextHost) s.favicon = null
        } catch {
          s.favicon = null
        }
      }
      try {
        historyOpenVisit(cardId, url, s?.workspaceCwd ?? null, 'navigate', {
          title: wc.getTitle() || null,
          favicon: s?.favicon ?? null
        })
      } catch (err) {
        console.error('[history] openVisit (did-navigate) failed:', err)
      }
      fire()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) {
        fire()
        return
      }
      const s = this.views.get(cardId)
      try {
        historyOpenVisit(cardId, url, s?.workspaceCwd ?? null, 'in-page', {
          title: wc.getTitle() || null,
          favicon: s?.favicon ?? null
        })
      } catch (err) {
        console.error('[history] openVisit (did-navigate-in-page) failed:', err)
      }
      fire()
    })
    // Navegação top-level falhou (DNS, conexão recusada, certificado, timeout). Sem este
    // handler o WebContentsView fica em branco — diferente do Chrome.exe, o Electron não
    // ship'a uma página interstitial padrão. Carregamos a nossa via data: URL.
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Sub-frames falhando (iframe de ad, fetch redirect): página principal pode estar OK.
      if (!isMainFrame) {
        fire()
        return
      }
      // -3 = ERR_ABORTED: navegação superseded (usuário clicou outro link antes do load
      // terminar, redirect que invalida a entrada anterior, etc). Não é falha real.
      if (errorCode === -3) {
        fire()
        return
      }
      const s = this.views.get(cardId)
      if (s) s.failedUrl = validatedURL || ''
      const html = buildErrorPageHtml(validatedURL || '', errorCode, errorDescription || '')
      void wc
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .catch(() => {})
      fire()
    })
    wc.on('page-title-updated', (_e, title) => {
      // Página de erro interna seta um <title> nosso pra UX dela mesma, mas isso não pode
      // vazar como "título do card" (sobrescreveria o título persistido com algo tipo
      // "Falha ao carregar"). Skip enquanto failedUrl ativo.
      const s = this.views.get(cardId)
      if (s?.failedUrl) {
        fire()
        return
      }
      try {
        historyPatchTitle(cardId, title)
      } catch (err) {
        console.error('[history] patchTitle failed:', err)
      }
      fire()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      const s = this.views.get(cardId)
      if (!s) return
      const next = favicons?.[0] ?? null
      if (s.favicon === next) return
      s.favicon = next
      try {
        historyPatchFavicon(cardId, next)
      } catch (err) {
        console.error('[history] patchFavicon failed:', err)
      }
      fire()
    })
    // Intercept Cmd+Opt+I (mac), Ctrl+Shift+I (others), and F12 so they open devtools on
    // THIS view instead of being eaten by the page. Without this the WebContentsView swallows
    // the keystroke (it has focus) and the user can't inspect what the page is doing.
    //
    // The fixed decky accels (Cmd+P palette, Cmd+Shift+F find, Cmd+N new session, Cmd+K
    // close session) are bound as native menu accelerators in main/menu.ts — the OS handles
    // those before any webContents sees them, which is the only thing that survives a focused
    // PDF viewer (its native plugin captures input before before-input-event fires here).
    //
    // What remains in this whitelist are accels that can't go in the menu: keymap-configurable
    // bindings (Cmd+Arrow* session/tab nav, Cmd+Ctrl+P tab.pin) and Cmd+Enter (contextual,
    // commits a preview-nav cursor). These still flow through the renderer's capture-phase
    // keydown, so we re-broadcast them as a synthetic KeyboardEvent on window. Won't fire
    // over a focused PDF (plugin swallows them), but works over HTML pages.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const isMac = process.platform === 'darwin'
      const macToggle = isMac && input.meta && input.alt && (input.code === 'KeyI' || input.key === 'I' || input.key === 'i')
      const winToggle = !isMac && input.control && input.shift && (input.code === 'KeyI' || input.key === 'I' || input.key === 'i')
      const f12 = input.key === 'F12'
      if (macToggle || winToggle || f12) {
        event.preventDefault()
        if (wc.isDevToolsOpened()) wc.closeDevTools()
        else wc.openDevTools({ mode: 'detach' })
        return
      }
      const k = input.key
      const primary = isMac ? input.meta && !input.control : input.control && !input.meta
      const isLetter = (ch: string): boolean => k === ch || k === ch.toUpperCase()
      let isDeckyAccel = false
      if (primary && !input.alt) {
        if (k === 'Enter') isDeckyAccel = true
        else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') isDeckyAccel = true
      }
      // tab.pin default: Cmd+Ctrl+P (mac) / Ctrl+Alt+P (others)
      if (!isDeckyAccel) {
        if (isMac && input.meta && input.control && !input.alt && isLetter('p')) isDeckyAccel = true
        else if (!isMac && input.control && input.alt && !input.meta && isLetter('p')) isDeckyAccel = true
      }
      if (!isDeckyAccel) return
      event.preventDefault()
      const win = this.getWin()
      if (!win || win.isDestroyed()) return
      // IPC > sendInputEvent: synthetic input events from Chromium were arriving in the renderer
      // without metaKey/ctrlKey populated, so the App.tsx keydown handler never recognized them.
      // The renderer side dispatches a real KeyboardEvent on window using this payload.
      win.webContents.send('app:shortcut', {
        key: k,
        shift: input.shift,
        control: input.control,
        alt: input.alt,
        meta: input.meta
      })
    })
    // Right-click context menu. WebContentsView has none by default, so right-clicking on
    // an image / link / selection in a web card was a no-op. Surface the three "Copy URL"-
    // shaped actions a browser would offer:
    //   - over an image      → Copy image URL  (params.srcURL)
    //   - over a link        → Copy link URL   (params.linkURL)
    //   - over a selection   → Copy            (selected text)
    // Plus a "Reload" fallback so the menu isn't empty on a bare page right-click.
    wc.on('context-menu', (_e, params) => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) return
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.mediaType === 'image' && params.srcURL) {
        items.push({
          label: 'Copy image URL',
          click: () => clipboard.writeText(params.srcURL)
        })
      }
      if (params.linkURL) {
        items.push({
          label: 'Copy link URL',
          click: () => clipboard.writeText(params.linkURL)
        })
      }
      if (params.selectionText) {
        items.push({
          label: 'Copy',
          click: () => wc.copy()
        })
      }
      if (items.length === 0) {
        items.push({ label: 'Reload', click: () => wc.reload() })
      }
      Menu.buildFromTemplate(items).popup({ window: win })
    })
    // Re-inject the cmd/ctrl-click capture on every load. The previous override is wiped by
    // the navigation, so the renderer relies on this to keep modifier-click → new card alive.
    wc.on('dom-ready', () => {
      void wc.executeJavaScript(POPUP_CAPTURE).catch(() => {})
      // Mesmo motivo pro blocker do handoff: navegação limpou o handler instalado.
      const s = this.views.get(cardId)
      if (s?.controlling) void wc.executeJavaScript(INSTALL_INPUT_BLOCKER).catch(() => {})
    })
    // DIAG: with DECKY_WEB_DIAG=1 in env, dump what the page actually sees after first load
    // (navUA, userAgentData, webdriver, window.chrome shape) so we can confirm the stealth
    // preload reached the main world. Mirrors decky-browser's DIAG path.
    if (process.env.DECKY_WEB_DIAG) {
      wc.once('did-finish-load', () => {
        void wc
          .executeJavaScript(
            `(async () => {
               const uad = navigator.userAgentData;
               let high = 'n/a';
               try { high = uad ? await uad.getHighEntropyValues(['platformVersion','fullVersionList','architecture','bitness']) : 'no uaData'; } catch (e) { high = 'hev failed: ' + e; }
               return JSON.stringify({
                 location: location.href,
                 navUA: navigator.userAgent,
                 uaDataBrands: uad ? uad.brands : 'undefined',
                 highEntropy: high,
                 webdriver: navigator.webdriver,
                 hasChrome: typeof window.chrome,
                 chromeKeys: window.chrome ? Object.keys(window.chrome) : []
               }, null, 2);
             })()`
          )
          .then((r) => console.log('[DECKY_WEB_DIAG card ' + cardId + ']\\n' + r))
          .catch((e) => console.log('[DECKY_WEB_DIAG card ' + cardId + '] executeJS failed', e))
      })
    }
    // Same channel the old <webview> code piped clicks through — main forwards to the renderer.
    wc.on('console-message', (e) => {
      const msg = e.message ?? ''
      const m = /^__DECKY_POPUP__:(.+)$/.exec(msg)
      if (m) {
        const win = this.getWin()
        win?.webContents.send('app:open-url', m[1])
        return
      }
      // Errors/warnings from inside card pages were invisible before — leaving silent bugs
      // like "card:// page stuck on carregando…" without ground truth in the logs. Forward
      // anything at warning level or worse to decky-startup.log so it's grepable next time.
      if (e.level === 'warning' || e.level === 'error') {
        const where = e.sourceId ? `${e.sourceId}:${e.lineNumber ?? '?'}` : 'unknown'
        wlog(`[card ${cardId}] console.${e.level} @ ${where}: ${msg.slice(0, 500)}`)
      }
    })
  }

  // Abre um modal nativo pedindo usuário/senha (réplica do popup de Basic Auth do Chrome).
  // Resolve com as credenciais digitadas ou null (cancelado / janela fechada). A página do modal
  // é uma data: URL estática que devolve o resultado via console.log('__DECKY_AUTH__:…') — mesmo
  // canal console-message já usado pra capturar popups (__DECKY_POPUP__), sem precisar de preload.
  private promptForCredentials(
    authInfo: Electron.AuthInfo
  ): Promise<{ username: string; password: string } | null> {
    return new Promise((resolve) => {
      const parent = this.getWin()
      const authWin = new BrowserWindow({
        parent: parent ?? undefined,
        modal: !!parent,
        width: 460,
        height: 252,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'Autenticação necessária',
        backgroundColor: '#1a1a1a',
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      })
      let settled = false
      const finish = (result: { username: string; password: string } | null): void => {
        if (settled) return
        settled = true
        resolve(result)
        if (!authWin.isDestroyed()) authWin.close()
      }
      authWin.webContents.on('console-message', (e) => {
        const m = /^__DECKY_AUTH__:([\s\S]*)$/.exec(e.message ?? '')
        if (!m) return
        if (m[1] === 'cancel') {
          finish(null)
          return
        }
        try {
          const parsed = JSON.parse(m[1])
          finish({
            username: String(parsed.username ?? ''),
            password: String(parsed.password ?? '')
          })
        } catch {
          finish(null)
        }
      })
      // Fechar pelo X (ou Esc fechando a janela) sem ter respondido = cancelar.
      authWin.once('closed', () => {
        if (!settled) {
          settled = true
          resolve(null)
        }
      })
      authWin.once('ready-to-show', () => authWin.show())
      void authWin.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildAuthPromptHtml(authInfo))}`
      )
    })
  }

  // Snapshot of a view's state for the renderer's address bar / nav buttons. Returns null if
  // the view doesn't exist (the renderer can then show a stale "loading" until create acks).
  snapshot(cardId: string): {
    url: string
    title: string
    favicon: string | null
    loading: boolean
    canBack: boolean
    canFwd: boolean
  } | null {
    const s = this.views.get(cardId)
    if (!s) return null
    const wc = s.view.webContents
    // Página de erro está em tela: reporta a URL/host que falhou pra address bar e tab
    // continuarem mostrando o destino "lógico", não o data: URL feio do interstitial.
    if (s.failedUrl) {
      let host = ''
      try {
        host = new URL(s.failedUrl).host
      } catch {
        host = s.failedUrl
      }
      return {
        url: s.failedUrl,
        title: host,
        favicon: null,
        loading: false,
        canBack: wc.navigationHistory.canGoBack(),
        canFwd: wc.navigationHistory.canGoForward()
      }
    }
    return {
      url: wc.getURL() || '',
      title: wc.getTitle() || '',
      favicon: s.favicon,
      loading: wc.isLoadingMainFrame(),
      canBack: wc.navigationHistory.canGoBack(),
      canFwd: wc.navigationHistory.canGoForward()
    }
  }
}

// Mapa de códigos de erro Chromium mais comuns → explicação curta em PT-BR. O nome textual
// (errorDescription, ex "ERR_NAME_NOT_RESOLVED") sempre vai pra tela como detalhe técnico; este
// mapa só fornece a frase amigável de cabeçalho. Códigos fora da lista caem num genérico.
const ERROR_HINTS: Record<number, string> = {
  [-7]: 'A conexão demorou demais pra responder.',
  [-21]: 'A rede mudou no meio do carregamento.',
  [-100]: 'A conexão foi fechada antes do site responder.',
  [-101]: 'A conexão foi resetada.',
  [-102]: 'O servidor recusou a conexão.',
  [-105]: 'Não foi possível encontrar o endereço deste site.',
  [-106]: 'Parece que você está sem internet.',
  [-107]: 'Erro de protocolo SSL.',
  [-108]: 'Endereço inválido.',
  [-109]: 'Endereço inalcançável.',
  [-118]: 'A conexão expirou.',
  [-130]: 'Falha na conexão com o proxy.',
  [-137]: 'Falha na resolução de DNS.',
  [-201]: 'Certificado inválido.',
  [-202]: 'Autoridade certificadora não confiável.',
  [-300]: 'URL inválida.',
  [-324]: 'O servidor não devolveu nenhuma resposta.',
  [-501]: 'Conteúdo inseguro bloqueado.'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Página de erro mostrada no WebContentsView quando did-fail-load dispara pra navegação top-level.
// Estilo dark pra casar com o shell do decky. Bem minimal: cabeçalho + URL + descrição + botão
// Retry (link <a> simples — clicar re-dispara loadURL na URL real, que pode falhar de novo e
// renderizar essa página outra vez, sem loop infinito porque cada iteração espera input humano).
function buildErrorPageHtml(failedUrl: string, code: number, desc: string): string {
  let host = failedUrl
  try {
    host = new URL(failedUrl).host || failedUrl
  } catch {
    // mantém failedUrl como fallback
  }
  const hint = ERROR_HINTS[code] || 'Não foi possível carregar este site.'
  const safeUrl = escapeHtml(failedUrl)
  const safeHost = escapeHtml(host)
  const safeDesc = escapeHtml(desc || `ERR_${code}`)
  const safeHint = escapeHtml(hint)
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>${safeHost} — não carregou</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #1a1a1a;
    color: #e6e6e6;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 520px;
    width: 100%;
  }
  .icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: #2a2a2a;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
    font-size: 24px;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 8px;
    color: #fff;
  }
  p {
    margin: 0 0 16px;
    color: #b3b3b3;
  }
  .url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #8a8a8a;
    word-break: break-all;
    background: #232323;
    padding: 8px 10px;
    border-radius: 6px;
    margin-bottom: 20px;
  }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: #707070;
    margin-bottom: 24px;
  }
  .retry {
    display: inline-block;
    background: #3a3a3a;
    color: #fff;
    text-decoration: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.12s ease;
  }
  .retry:hover { background: #4a4a4a; }
  .retry:active { background: #303030; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">⚠️</div>
    <h1>${safeHint}</h1>
    <p>Não foi possível abrir <strong>${safeHost}</strong>. Verifique o endereço, sua conexão, ou se o site está fora do ar.</p>
    <div class="url">${safeUrl}</div>
    <div class="code">${safeDesc}</div>
    <a class="retry" href="${safeUrl}">Tentar novamente</a>
  </div>
</body>
</html>`
}

// Modal de credenciais (HTTP Basic/Digest). Estilo dark casando com o shell e a página de erro.
// Devolve o resultado por console.log('__DECKY_AUTH__:<json|cancel>') — capturado em
// promptForCredentials. Enter envia, Esc cancela; sem <form> pra não disparar navegação no submit.
function buildAuthPromptHtml(authInfo: Electron.AuthInfo): string {
  const showPort =
    !authInfo.isProxy && !!authInfo.port && authInfo.port !== 80 && authInfo.port !== 443
  const host = authInfo.isProxy
    ? `proxy ${authInfo.host}:${authInfo.port}`
    : `${authInfo.host}${showPort ? ':' + authInfo.port : ''}`
  const safeHost = escapeHtml(host)
  const safeRealm = escapeHtml(authInfo.realm || '')
  const realmLine = safeRealm ? `<div class="realm">${safeRealm}</div>` : ''
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Autenticação necessária</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #1a1a1a;
    color: #e6e6e6;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    padding: 18px 20px;
    box-sizing: border-box;
    -webkit-user-select: none;
    user-select: none;
  }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 4px; color: #fff; }
  .host {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: #8a8a8a; word-break: break-all; margin-bottom: 2px;
  }
  .realm { font-size: 12px; color: #707070; margin-bottom: 12px; }
  label { display: block; font-size: 11px; color: #9a9a9a; margin: 8px 0 3px; }
  input {
    width: 100%; box-sizing: border-box; background: #232323; color: #e6e6e6;
    border: 1px solid #3a3a3a; border-radius: 6px; padding: 7px 9px; font-size: 13px;
    outline: none; -webkit-user-select: text; user-select: text;
  }
  input:focus { border-color: #5a7fb3; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button {
    border: 0; border-radius: 6px; padding: 7px 16px; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: background 0.12s ease;
  }
  #cancel { background: #2e2e2e; color: #cfcfcf; }
  #cancel:hover { background: #383838; }
  #ok { background: #3a5a86; color: #fff; }
  #ok:hover { background: #466a9c; }
</style>
</head>
<body>
  <h1>Autenticação necessária</h1>
  <div class="host">${safeHost}</div>
  ${realmLine}
  <label for="u">Usuário</label>
  <input id="u" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
  <label for="p">Senha</label>
  <input id="p" type="password" autocomplete="off">
  <div class="row">
    <button id="cancel" type="button">Cancelar</button>
    <button id="ok" type="button">Entrar</button>
  </div>
  <script>
    var u = document.getElementById('u');
    var p = document.getElementById('p');
    function ok() {
      console.log('__DECKY_AUTH__:' + JSON.stringify({ username: u.value, password: p.value }));
    }
    function cancel() { console.log('__DECKY_AUTH__:cancel'); }
    document.getElementById('ok').addEventListener('click', ok);
    document.getElementById('cancel').addEventListener('click', cancel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    u.focus();
  </script>
</body>
</html>`
}

// Blocker de input HUMANO injetado na página quando o handoff está dirigindo o card. Usa
// listeners em capture no document filtrando por `e.isTrusted`: eventos REAIS do usuário
// (kb/mouse vindos do OS, isTrusted=true) são preventDefault + stopImmediatePropagation;
// eventos SINTÉTICOS disparados pelo handoff via `el.click()` / `el.dispatchEvent(...)` têm
// isTrusted=false, escapam o filtro e funcionam normalmente. Sem overlay no DOM → não bagunça
// hit-test do agente, layout do site, nem cursor.
const INSTALL_INPUT_BLOCKER = `
(() => {
  if (window.__deckyHandoffBlocker) return;
  const TYPES = [
    'keydown','keypress','keyup',
    'mousedown','mouseup','click','dblclick','contextmenu','wheel',
    'pointerdown','pointerup','pointermove',
    'touchstart','touchend','touchmove',
    'input','beforeinput','compositionstart','compositionupdate','compositionend',
    'paste','cut','drop','dragstart'
  ];
  const block = (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  TYPES.forEach((t) => document.addEventListener(t, block, { capture: true }));
  // Tira o foco do que estiver focado pra evitar caret piscando "dentro" de input enquanto
  // o humano não pode digitar — sinal visual extra de que ele não é o motorista agora.
  const active = document.activeElement;
  if (active && typeof active.blur === 'function' && active !== document.body) {
    try { active.blur(); } catch (_) {}
  }
  window.__deckyHandoffBlocker = {
    off: () => TYPES.forEach((t) => document.removeEventListener(t, block, { capture: true }))
  };
})();
`

const UNINSTALL_INPUT_BLOCKER = `
(() => {
  const b = window.__deckyHandoffBlocker;
  if (!b) return;
  try { b.off(); } catch (_) {}
  delete window.__deckyHandoffBlocker;
})();
`

// Modifier-click capture, formerly injected from the renderer into <webview> guests. Same
// payload — kept here because the WebContentsView is driven from main and there's no longer
// a single React component that owns "what to inject on every page load".
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

let manager: WebViewsManager | null = null

export function getWebViewsManager(): WebViewsManager | null {
  return manager
}

export function setupWebViews(getWin: () => BrowserWindow | null): void {
  manager = new WebViewsManager(getWin)

  const emitState = (cardId: string): void => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const snap = manager!.snapshot(cardId)
    if (!snap) return
    win.webContents.send('web:state', { cardId, ...snap })
  }

  ipcMain.handle(
    'web:create',
    (_e, payload: { cardId: string; url: string; workspaceCwd?: string | null }) => {
      manager!.create(
        payload.cardId,
        payload.url || '',
        payload.workspaceCwd ?? null,
        emitState
      )
      // Emit one synthetic state right after create so the renderer can populate the address
      // bar without waiting for the first navigation event.
      emitState(payload.cardId)
      return true
    }
  )
  ipcMain.handle('web:destroy', (_e, cardId: string) => {
    manager!.destroy(cardId)
    return true
  })
  // Ping de "estou digitando" do renderer — alimenta o anti-roubo de foco em wireEvents (wc.on focus).
  ipcMain.on('app:typing-ping', () => noteRendererTyping())
  ipcMain.on('web:set-bounds', (_e, payload: { cardId: string; bounds: Bounds }) => {
    manager!.setBounds(payload.cardId, payload.bounds)
  })
  ipcMain.on('web:hide', (_e, cardId: string) => {
    manager!.hide(cardId)
  })
  ipcMain.on('web:navigate', (_e, payload: { cardId: string; url: string }) => {
    manager!.navigate(payload.cardId, payload.url)
  })
  ipcMain.on('web:back', (_e, cardId: string) => manager!.back(cardId))
  ipcMain.on('web:forward', (_e, cardId: string) => manager!.forward(cardId))
  ipcMain.on('web:reload', (_e, cardId: string) => manager!.reload(cardId))
  ipcMain.on(
    'web:patch',
    (
      _e,
      payload: {
        cardId: string
        patch: { op: string; type?: string; id?: string; spec?: unknown; n?: number }
      }
    ) => manager!.patchCard(payload.cardId, payload.patch)
  )
  ipcMain.on('web:stop', (_e, cardId: string) => manager!.stop(cardId))
  ipcMain.on('web:open-devtools', (_e, cardId: string) => manager!.toggleDevTools(cardId))
  ipcMain.handle('web:get-state', (_e, cardId: string) => manager!.snapshot(cardId))
  // Renderer pergunta o estado atual de "controlando" no mount — caso o handoff já tenha
  // ligado antes do WebPreview montar (workspace switch durante uma sequência de comandos).
  ipcMain.handle('web:get-controlling', (_e, cardId: string) => {
    return manager!.isControlling(cardId)
  })
}

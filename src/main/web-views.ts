import {
  WebContentsView,
  ipcMain,
  Menu,
  clipboard,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { WEB_PARTITION } from './web-session'
import { diag } from './diag'
import {
  openVisit as historyOpenVisit,
  closeVisit as historyCloseVisit,
  patchTitle as historyPatchTitle,
  patchFavicon as historyPatchFavicon,
  setVisible as historySetVisible,
  getOpenVisitUrl as historyGetOpenVisitUrl
} from './history/capture'

// Tracing the create/destroy/bounds lifecycle per card (decky-startup.log). Logs only
// structural events (first attach, zero-size hide, missing-entry drops, create/destroy)
// — the geometry pump dedupes identical bounds, so steady state stays quiet.
// Opt-out: DECKY_NO_WEB_LIFECYCLE_DIAG=1.
const LIFECYCLE_DIAG = !process.env.DECKY_NO_WEB_LIFECYCLE_DIAG
const wlog = (msg: string): void => {
  if (LIFECYCLE_DIAG) diag(`[web-views] ${msg}`)
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
        contextIsolation: false
      }
    })
    const wc = view.webContents
    const state: ViewState = {
      view,
      initialUrl,
      attached: false,
      controlling: false,
      favicon: null,
      workspaceCwd,
      pendingUrl: initialUrl && initialUrl !== 'about:blank' ? initialUrl : null
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
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    void wc.loadURL(url).catch(() => {})
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

  reload(cardId: string): void {
    this.views.get(cardId)?.view.webContents.reload()
  }

  stop(cardId: string): void {
    this.views.get(cardId)?.view.webContents.stop()
  }

  executeJavaScript(cardId: string, code: string): void {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return
    void wc.executeJavaScript(code).catch(() => {})
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
    wc.on('did-navigate', (_e, url) => {
      const s = this.views.get(cardId)
      // Top-level navigation pra outra origem → o favicon atual não vale mais. Limpa pra
      // não exibir o ícone do site anterior até o do novo chegar.
      if (s) {
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
    wc.on('did-fail-load', fire)
    wc.on('page-title-updated', (_e, title) => {
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
      const m = /^__DECKY_POPUP__:(.+)$/.exec(e.message ?? '')
      if (!m) return
      const win = this.getWin()
      win?.webContents.send('app:open-url', m[1])
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
  ipcMain.on('web:stop', (_e, cardId: string) => manager!.stop(cardId))
  ipcMain.on('web:open-devtools', (_e, cardId: string) => manager!.toggleDevTools(cardId))
  ipcMain.handle('web:get-state', (_e, cardId: string) => manager!.snapshot(cardId))
  // Renderer pergunta o estado atual de "controlando" no mount — caso o handoff já tenha
  // ligado antes do WebPreview montar (workspace switch durante uma sequência de comandos).
  ipcMain.handle('web:get-controlling', (_e, cardId: string) => {
    return manager!.isControlling(cardId)
  })
}

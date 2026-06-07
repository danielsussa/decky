import { WebContentsView, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { WEB_PARTITION } from './web-session'
import { diag } from './diag'

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

  create(cardId: string, initialUrl: string, emit: EmitState): void {
    if (this.views.has(cardId)) {
      // Already created — if the URL changed (rehydrate path), navigate; otherwise no-op.
      const s = this.views.get(cardId)!
      wlog(`create ${cardId} → existing entry (attached=${s.attached}), url=${initialUrl || '<empty>'}`)
      if (initialUrl && initialUrl !== s.initialUrl) {
        s.initialUrl = initialUrl
        if (initialUrl !== 'about:blank') {
          void s.view.webContents.loadURL(initialUrl).catch(() => {})
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
    const state: ViewState = { view, initialUrl, attached: false, controlling: false }
    this.views.set(cardId, state)
    this.wireEvents(cardId, wc, emit)

    if (initialUrl && initialUrl !== 'about:blank') {
      void wc.loadURL(initialUrl).catch(() => {})
    }
  }

  destroy(cardId: string): void {
    const s = this.views.get(cardId)
    if (!s) {
      wlog(`destroy ${cardId} → no entry`)
      return
    }
    wlog(`destroy ${cardId} (attached=${s.attached})`)
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
    wc.on('did-navigate', fire)
    wc.on('did-navigate-in-page', fire)
    wc.on('did-fail-load', fire)
    wc.on('page-title-updated', fire)
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
    loading: boolean
    canBack: boolean
    canFwd: boolean
  } | null {
    const wc = this.views.get(cardId)?.view.webContents
    if (!wc) return null
    return {
      url: wc.getURL() || '',
      title: wc.getTitle() || '',
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

  ipcMain.handle('web:create', (_e, payload: { cardId: string; url: string }) => {
    manager!.create(payload.cardId, payload.url || '', emitState)
    // Emit one synthetic state right after create so the renderer can populate the address
    // bar without waiting for the first navigation event.
    emitState(payload.cardId)
    return true
  })
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
  ipcMain.handle('web:get-state', (_e, cardId: string) => manager!.snapshot(cardId))
  // Renderer pergunta o estado atual de "controlando" no mount — caso o handoff já tenha
  // ligado antes do WebPreview montar (workspace switch durante uma sequência de comandos).
  ipcMain.handle('web:get-controlling', (_e, cardId: string) => {
    return manager!.isControlling(cardId)
  })
}

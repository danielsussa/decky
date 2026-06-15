import { diag, installCrashLogging } from '@decky/server'
installCrashLogging()
import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  dialog,
  nativeTheme
} from 'electron'
import { join } from 'path'
import { existsSync, statSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildMenu } from './menu'
import { LOCALE_ARG_PREFIX, normalizeLocale, WS_URL_PREFIX } from '@decky/shared'
import {
  LOCAL_ENGINE_ID,
  serializeEngines,
  type Engine,
  type ServerEngineConfig
} from '@decky/shared'
import { registerPtyHandlers, killAllPtys } from './pty'
import {
  startPreviewServer,
  stopPreviewServer,
  getPreviewSources,
  getSessionTitles,
  rehydratePreviews
} from './preview-server'
import { registerLegacyIpcBridges } from './legacy-ipc'
import { openRemoteSilent, registerSshHandlers } from './ssh-bridge'
import { registerCardsHandlers } from './cards-store'
import { registerTagsIndexHandlers } from './tags-index-watcher'
import { searchCards } from '@decky/server'
import { resolveWikilink, computeBacklinks } from '@decky/server'
import { workspaceCardsDir } from '@decky/shared/node'
import { registerCardMirrorHandlers } from './card-mirror'
import { registerWidgetBridge } from '@decky/server'
import { migrateGlobalState } from '@decky/server'
import { registerFileWatchHandlers } from './file-watcher'
import { ensureDeckMcpRegistered } from '@decky/server'
import { ensureDeckInstruction } from '@decky/server'
import { ensureDeckyHooks } from '@decky/server'
import { resolveClaudeBin, readAiTitle } from '@decky/server'
import { initCliPaths } from '@decky/server'
import { registerStateWsHandlers, getState, setState } from '@decky/server'
import { registerCliWsHandlers } from '@decky/server'
import { registerGitWsHandlers } from '@decky/server'
import { registerWorkspaceWsHandlers } from '@decky/server'
import { registerTagsIndexWsHandlers } from '@decky/server'
import { registerHistoryWsHandlers } from '@decky/server'
import { startWsServer, type DeckyWsServer } from '@decky/server'
import { registerDevRebuildHandlers } from './dev-rebuild'
import { getBuildInfo } from '@decky/shared'
import { registerAssetScheme, setupAssetProtocol } from './asset-protocol'
import { registerCardScheme, setupCardProtocol, cardUrlToAbsPath } from './card-protocol'
import { setupWebSession, attachWebContentsPopupRouter } from './web-session'
import { setupWebViews } from './web-views'
import { setupHistory } from './history'
import { setupHtmlServer } from './html-server'

// Privileged scheme registration must happen before app is ready.
registerAssetScheme()
registerCardScheme()

// Disable FedCM globally. Google Identity Services (used by Pinterest, Spotify, many sites'
// "Continue with Google") calls navigator.credentials.get({identity}) FIRST and only falls
// back to the legacy popup OAuth flow when the API throws NotSupportedError. With FedCM
// enabled, Chromium responds with NetworkError (the IdP config fetch fails inside Electron's
// partition because there's no signed-in Google session + the spoofed UA/client-hints confuse
// accounts.google.com's well-known endpoint), and GSI keeps retrying forever — symptom: the
// "Continue with Google" button does NOTHING. Disabling FedCM makes the API return
// NotSupportedError immediately, GSI falls back to popup, and setWindowOpenHandler in
// web-session.ts routes the OAuth window correctly.
app.commandLine.appendSwitch('disable-features', 'FedCm,FedCmAuthz,FedCmIdpSigninStatusEnabled,FedCmAutoSelectedFlag')

let mainWindow: BrowserWindow | null = null
let wsServer: DeckyWsServer | null = null
// Multi-engine: o local embarcado SEMPRE sobe; servers remotos são additivos. Esta lista
// (local + servers) é resolvida no boot e passada pro preload via --decky-engines argv. Antes,
// um remoto setado SUPRIMIA o local — era o que escondia as sessões locais ao "add server".
let rendererEngines: Engine[] = []

function hostLabelFromUrl(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// Migra o modelo single-engine antigo (remoteEngineUrl/Token no state) pro novo engines[].
// Crucial: limpa as chaves legadas pra que o boot pare de suprimir o local — é o que faz as
// sessões locais reaparecerem. O server migrado entra offline (o túnel do boot anterior morreu);
// reconecta pelo modal "Add server".
async function migrateLegacyRemote(): Promise<void> {
  const legacyUrl = await getState<string>('remoteEngineUrl')
  if (!legacyUrl) return
  const legacyToken = await getState<string>('remoteEngineToken')
  const servers = (await getState<ServerEngineConfig[]>('engines')) ?? []
  if (!servers.some((s) => s.url === legacyUrl)) {
    servers.push({
      id: `srv-${crypto.randomUUID().slice(0, 8)}`,
      kind: 'server',
      label: hostLabelFromUrl(legacyUrl),
      url: legacyUrl,
      token: legacyToken || undefined
    })
    await setState('engines', servers)
  }
  await setState('remoteEngineUrl', '')
  await setState('remoteEngineToken', '')
}

async function loadServerConfigs(): Promise<ServerEngineConfig[]> {
  return (await getState<ServerEngineConfig[]>('engines')) ?? []
}

function serverConfigToEngine(cfg: ServerEngineConfig): Engine {
  return {
    id: cfg.id,
    kind: 'server',
    label: cfg.label,
    url: cfg.url ?? '',
    token: cfg.token,
    sshHost: cfg.sshHost,
    sshIdentity: cfg.sshIdentity
  }
}

// Monta a lista completa: local (sempre) + servers persistidos + override de env (DECKY_REMOTE_WS_URL,
// ephemeral — não persiste). Chamada no boot e após engines:add/remove.
async function buildEngineList(): Promise<Engine[]> {
  await migrateLegacyRemote()
  const local: Engine = {
    id: LOCAL_ENGINE_ID,
    kind: 'local',
    label: 'local',
    url: wsServer?.url ?? ''
  }
  const servers = (await loadServerConfigs()).map(serverConfigToEngine)
  const envUrl = process.env.DECKY_REMOTE_WS_URL
  if (envUrl && !servers.some((s) => s.url === envUrl)) {
    servers.push({
      id: 'env-remote',
      kind: 'server',
      label: hostLabelFromUrl(envUrl),
      url: envUrl,
      token: process.env.DECKY_REMOTE_WS_TOKEN || undefined
    })
  }
  return [local, ...servers]
}

async function addServerEngine(cfg: ServerEngineConfig & { url: string }): Promise<Engine> {
  const servers = await loadServerConfigs()
  // Dedup por sshHost — é o que identifica unicamente a engine (a url muda toda vez porque
  // a porta do tunnel SSH é livre/ephemeral, então deduplicar por url criava entry nova a
  // cada conexão). Fallback pra id explícito (relink após perda de state) e por último pra
  // url (caso o config tenha vindo sem sshHost — env override DECKY_REMOTE_WS_URL, etc).
  const existing = servers.find((s) =>
    cfg.sshHost && s.sshHost
      ? s.sshHost === cfg.sshHost
      : cfg.id && s.id === cfg.id
        ? true
        : s.url === cfg.url
  )
  const engine: ServerEngineConfig = {
    id: existing?.id ?? cfg.id ?? `srv-${crypto.randomUUID().slice(0, 8)}`,
    kind: 'server',
    label: cfg.label || hostLabelFromUrl(cfg.url),
    url: cfg.url,
    token: cfg.token,
    sshHost: cfg.sshHost ?? existing?.sshHost,
    sshIdentity: cfg.sshIdentity ?? existing?.sshIdentity
  }
  const next = existing
    ? servers.map((s) => (s.id === engine.id ? engine : s))
    : [...servers, engine]
  await setState('engines', next)
  return serverConfigToEngine(engine)
}

async function reconnectAllRemoteEngines(): Promise<void> {
  const servers = await loadServerConfigs()
  await Promise.allSettled(
    servers.map(async (s) => {
      if (!s.sshHost) return
      try {
        const r = await openRemoteSilent(s.sshHost, s.sshIdentity)
        if (!r.ok || !r.localUrl || !r.token) {
          diag(`[engines] reconnect ${s.id} failed: ${r.error ?? 'no result'}`)
          return
        }
        // Atualiza state com nova url+token.
        const cfgs = await loadServerConfigs()
        const i = cfgs.findIndex((c) => c.id === s.id)
        if (i >= 0) {
          cfgs[i] = { ...cfgs[i], url: r.localUrl, token: r.token }
          await setState('engines', cfgs)
        }
        // Atualiza rendererEngines pra que listEngines() do preload pegue dali em diante.
        rendererEngines = await buildEngineList()
        // Push pro preload trocar a conexão WS pra url nova.
        const engine = rendererEngines.find((e) => e.id === s.id)
        if (engine) wsServer?.broadcast('engines:updated', engine)
        diag(`[engines] reconnect ${s.id} ok — ${r.localUrl}`)
      } catch (err) {
        diag(`[engines] reconnect ${s.id} threw: ${(err as Error).message}`)
      }
    })
  )
}

async function removeServerEngine(engineId: string): Promise<boolean> {
  if (!engineId) return false
  const servers = await loadServerConfigs()
  const next = servers.filter((s) => s.id !== engineId)
  await setState('engines', next)
  return next.length !== servers.length
}

// DECKY_DEV runs a fully isolated dev instance alongside the installed app: its own name +
// userData (→ separate single-instance lock, so both run), paired with DECKY_STATE_DIR /
// DECKY_PREVIEW_PORT / DECKY_URL from the `dev` script. Must run BEFORE the lock below,
// since requestSingleInstanceLock keys off userData.
if (process.env.DECKY_DEV) {
  app.setName('decky-dev')
  app.setPath('userData', join(app.getPath('appData'), 'decky-dev'))
}

// Single instance is the design: a relaunch (e.g. `decky ~/proj`) routes the folder
// into the running window as a workspace instead of spawning a second process.
function firstDirArg(argv: string[], fallbackCwd: string): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (a.startsWith('-')) continue
    try {
      if (existsSync(a) && statSync(a).isDirectory()) return a
    } catch {
      // not a path
    }
  }
  return existsSync(fallbackCwd) ? fallbackCwd : null
}

function routeFolderToWindow(dir: string | null): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  if (dir) {
    mainWindow.webContents.send('session:add', { cwd: dir, kind: 'claude' })
    wsServer?.broadcast('session:add', { cwd: dir, kind: 'claude' })
  }
}

diag('requesting single-instance lock')
const gotLock = app.requestSingleInstanceLock()
diag(`gotLock=${gotLock}`)
if (!gotLock) {
  // Another instance already holds the lock — the running one will get our argv via
  // 'second-instance' and route the folder into its window, so we exit. Log it: this is the
  // ONE startup path that quits before any other output, so a silent exit here is what makes
  // a stale/zombie holder look like "decky opens and does nothing". Never let it be silent.
  console.error('[decky] another instance already holds the single-instance lock — exiting.')
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    routeFolderToWindow(firstDirArg(argv, workingDirectory))
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'decky',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e2330',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
      // Surfaced sync to the renderer via preload (window.deck.app.locale) — no IPC round-trip,
      // no boot flicker. Resolved from app.getLocale() and normalized to a supported language.
      // --decky-engines: lista de engines (local embarcado + servers remotos). O preload abre
      // uma conexão WS por engine. Mantém --decky-ws-url=<local> por compat (back-compat no
      // ws-client se a lista vier vazia).
      additionalArguments: [
        `${LOCALE_ARG_PREFIX}${normalizeLocale(app.getLocale())}`,
        serializeEngines(rendererEngines),
        ...(wsServer?.url ? [`${WS_URL_PREFIX}${wsServer.url}`] : [])
      ]
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Route link clicks from anywhere in the renderer (markdown card, terminal weblinks, etc.)
  // into our internal web card instead of the OS browser. setWindowOpenHandler covers
  // window.open + target="_blank"; will-navigate covers plain <a href> clicks (without it
  // they'd navigate the WHOLE decky window away from the app shell). Non-http schemes and
  // explicit "open external" affordances still go through shell.openExternal via the
  // 'app:open-external' IPC.
  const routeToInternal = (url: string): void => {
    if (!/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => {})
      return
    }
    mainWindow?.webContents.send('app:open-url', url)
  }
  mainWindow.webContents.setWindowOpenHandler((details) => {
    routeToInternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Same-origin navigation = app shell itself (HMR, dev reload, file:// reload). Let it through.
    try {
      const current = mainWindow?.webContents.getURL() ?? ''
      if (current && new URL(url).origin === new URL(current).origin) return
    } catch {
      return
    }
    e.preventDefault()
    routeToInternal(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app
  .whenReady()
  .then(async () => {
    diag('whenReady fired')
    const build = getBuildInfo()
    diag(`build ${build.label}`)
    // macOS "About decky" panel: applicationVersion is the semver line, the `version` slot below
    // it carries our git label so a glance answers "qual commit é esse bundle?".
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      version: build.label,
      copyright: `© ${new Date().getUTCFullYear()} Daniel Kanczuk`
    })
    // Migrate pre-rename data (~/.deck → ~/.decky) BEFORE the renderer reads any state.
    await migrateGlobalState()
    diag('migrateGlobalState done')

    // Hydrate custom CLI paths before any cli:list call can race the renderer mount.
    await initCliPaths()
    diag('initCliPaths done')

    // Set app user model id for windows
    electronApp.setAppUserModelId('com.electron')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test
    ipcMain.on('ping', () => console.log('pong'))

    Menu.setApplicationMenu(buildMenu(() => mainWindow))

    registerPtyHandlers(() => mainWindow, () => wsServer)
    registerLegacyIpcBridges()

    // Engine local — SEMPRE sobe. Servers remotos são additivos (montados em rendererEngines
    // logo abaixo, antes de createWindow). O preload abre uma conexão WS por engine.
    {
      try {
        wsServer = await startWsServer()
        diag(`[ws-server] listening on ${wsServer.url}`)
        registerCliWsHandlers(wsServer)
        registerStateWsHandlers(wsServer)
        registerGitWsHandlers(wsServer)
        registerWorkspaceWsHandlers(wsServer)
        registerTagsIndexWsHandlers(wsServer)
        // claude:* não tem arquivo dedicado — handlers vivem inline em index.ts.
        wsServer.handle<void, string>('claude:get-bin', () => resolveClaudeBin())
        wsServer.handle<{ cwd: string; uuid: string }, string | null>(
          'claude:ai-title',
          (args) => readAiTitle(args?.cwd ?? '', args?.uuid ?? '')
        )
        // cards:* extras (search/resolve-wikilink/backlinks) também sem arquivo dedicado.
        wsServer.handle<{ workspace: string; query: string; limit?: number }, unknown>(
          'cards:search',
          (args) =>
            searchCards(
              workspaceCardsDir(args?.workspace ?? ''),
              args?.query ?? '',
              typeof args?.limit === 'number' ? args.limit : 20,
              'html'
            )
        )
        wsServer.handle<{ workspace: string; name: string }, string | null>(
          'cards:resolve-wikilink',
          (args) => resolveWikilink(workspaceCardsDir(args?.workspace ?? ''), args?.name ?? '')
        )
        wsServer.handle<{ workspace: string; cardPath: string }, unknown>(
          'cards:backlinks',
          (args) => computeBacklinks(workspaceCardsDir(args?.workspace ?? ''), args?.cardPath ?? '')
        )
        registerHistoryWsHandlers(wsServer)
        // theme:set-mode — Electron nativeTheme.themeSource só existe aqui.
        wsServer.handle<{ mode: 'dark' | 'light' }, boolean>('theme:set-mode', (args) => {
          nativeTheme.themeSource = args?.mode === 'light' ? 'light' : 'dark'
          return true
        })
        // sessions:get-titles — Map vive em preview-state (@decky/server).
        wsServer.handle<void, Record<string, string>>('sessions:get-titles', () =>
          getSessionTitles()
        )
        // ssh:* — SSH client no main, expõe ssh:exec pra UX do "Add server" rodar comandos no remote.
        registerSshHandlers(() => wsServer)
        // engines:add — recebe url+token+ssh do modal "Add server" (após install + open-remote).
        // Additivo: persiste o server na lista `engines` do state e devolve o Engine pro renderer
        // inserir na árvore SEM relaunch e SEM esconder o local. (Substitui o antigo
        // app:reopen-with-remote, que relançava apontando 100% pro remoto.)
        wsServer.handle<ServerEngineConfig & { url: string }, Engine>('engines:add', async (cfg) => {
          const engine = await addServerEngine(cfg)
          rendererEngines = await buildEngineList()
          return engine
        })
        wsServer.handle<{ engineId: string }, boolean>('engines:remove', async (args) => {
          const ok = await removeServerEngine(args?.engineId ?? '')
          rendererEngines = await buildEngineList()
          return ok
        })
        // preview:get-all/rehydrate — funções puras no server.
        wsServer.handle<void, Record<string, import('@decky/shared').PreviewSource>>(
          'preview:get-all',
          () => getPreviewSources()
        )
        wsServer.handle<
          {
            byCard: Record<string, Record<string, import('@decky/shared').PreviewSource>>
            workspace?: string
          },
          Record<string, Record<string, import('@decky/shared').PreviewSource>>
        >('preview:rehydrate', (args) => rehydratePreviews(args?.byCard ?? {}, args?.workspace))
      } catch (err) {
        console.error('[ws-server] failed to start:', err)
      }
    }
    // Resolve a lista de engines (local + servers persistidos + env override) ANTES de
    // createWindow — o argv --decky-engines é montado a partir dela.
    rendererEngines = await buildEngineList()
    diag(`[engines] ${rendererEngines.map((e) => `${e.id}(${e.kind})`).join(', ')}`)
    registerCardsHandlers(() => wsServer)
    registerTagsIndexHandlers()
    registerCardMirrorHandlers(() => mainWindow, () => wsServer)
    registerWidgetBridge(() => wsServer)
    registerFileWatchHandlers(() => mainWindow, () => wsServer)
    registerDevRebuildHandlers(() => mainWindow, () => wsServer)
    setupAssetProtocol()
    setupCardProtocol()
    // Global default UA: strip the Electron/app token so any web surface that falls back to it
    // (a popup in the instant before the deckweb partition UA applies) still reads as plain Chrome.
    // The per-partition setUserAgent in setupWebSession is the main path; this is the safety net.
    app.userAgentFallback = app.userAgentFallback
      .replace(`Electron/${process.versions.electron}`, '')
      .replace(`${app.getName()}/${app.getVersion()}`, '')
      .replace(/\s+/g, ' ')
      .trim()
    // Drive prefers-color-scheme inside every embedded webContents from decky's own theme mode
    // (persisted as 'themeMode' in state-store; toggled in the renderer). Set the initial value
    // from disk so the first web card created during startup already gets the right scheme,
    // then keep it in sync via the 'theme:set-mode' IPC the renderer calls on every toggle.
    const initialMode = await getState<'dark' | 'light'>('themeMode')
    nativeTheme.themeSource = initialMode === 'light' ? 'light' : 'dark'
    ipcMain.handle('theme:set-mode', (_e, mode: 'dark' | 'light') => {
      nativeTheme.themeSource = mode === 'light' ? 'light' : 'dark'
      return true
    })
    setupWebSession(() => mainWindow)
    attachWebContentsPopupRouter(() => mainWindow)
    setupHistory()
    setupWebViews(() => mainWindow)
    setupHtmlServer(() => wsServer)
    diag('handlers registered, starting preview server')
    startPreviewServer(() => mainWindow, () => wsServer)
    // O backend do handoff agora sobe POR SESSÃO em pty.ts (start no spawn / stop no exit),
    // bound em /tmp/handoff-decky-<sessionId>.sock e escopado em cards da própria sessão.
    // O HANDOFF_SOCKET do pty aponta clientes pra esse socket isolado. Sem chamada global aqui.

    ipcMain.handle('dialog:pick-folder', async () => {
      const opts: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Adicionar pasta de trabalho'
      }
      const res = mainWindow
        ? await dialog.showOpenDialog(mainWindow, opts)
        : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    })

    ipcMain.handle('dialog:pick-file', async (_e, title?: string) => {
      const opts: Electron.OpenDialogOptions = {
        // showHiddenFiles so users can navigate into ~/.local/bin etc.
        properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
        title: title ?? 'Escolher executável'
      }
      const res = mainWindow
        ? await dialog.showOpenDialog(mainWindow, opts)
        : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    })

    // Native desktop notification for "sessão terminou de processar". Renderer fires this when a
    // session transitions from working → idle and the user isn't looking (different session OR
    // window unfocused). Clicking the notification brings the app forward and tells the renderer
    // which session to switch to.
    function showNotification(payload: { id: string; title: string; body?: string }): void {
      const supported = Notification.isSupported()
      console.log('[notify] handler called', { supported, payload })
      if (!supported) return
      const n = new Notification({
        title: payload.title,
        body: payload.body ?? '',
        silent: false
      })
      n.on('show', () => console.log('[notify] shown', payload.id))
      n.on('failed', (_evt, err) => console.error('[notify] failed', err))
      n.on('click', () => {
        console.log('[notify] clicked', payload.id)
        const win = mainWindow
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        if (process.platform === 'darwin') app.focus({ steal: true })
        win.webContents.send('notify:focus-session', { id: payload.id })
        wsServer?.broadcast('notify:focus-session', { id: payload.id })
      })
      n.show()
    }
    ipcMain.handle('notify:show', (_e, payload: { id: string; title: string; body?: string }) =>
      showNotification(payload)
    )
    wsServer?.handle<{ id: string; title: string; body?: string }, void>(
      'notify:show',
      (payload) => showNotification(payload ?? { id: '', title: '' })
    )

    // Full-text search the workspace's card library (recursive over <workspace>/.decky/cards/).
    // Drives the in-app Cmd+Shift+F palette; the MCP `search_cards` tool uses the same helper
    // via the HTTP server (POST /cards/search).
    ipcMain.handle('cards:search', (_e, workspace: string, query: string, limit?: number) =>
      searchCards(
        workspaceCardsDir(workspace),
        query ?? '',
        typeof limit === 'number' ? limit : 20,
        'html'
      )
    )

    // Resolve `[[name]]` from a card body to its absolute .md path. Renderer calls this on
    // wikilink click so it can fire `decky:open-path`.
    ipcMain.handle('cards:resolve-wikilink', (_e, workspace: string, name: string) =>
      resolveWikilink(workspaceCardsDir(workspace), name)
    )

    // Reverse-link lookup for BacklinksFooter + the MCP `card_backlinks` tool.
    ipcMain.handle('cards:backlinks', (_e, workspace: string, cardPath: string) =>
      computeBacklinks(workspaceCardsDir(workspace), cardPath)
    )

    ipcMain.handle('preview:get-all', () => getPreviewSources())
    ipcMain.handle('preview:rehydrate', (_e, byCard, workspace?: string) =>
      rehydratePreviews(byCard, workspace)
    )
    ipcMain.handle('claude:get-bin', () => resolveClaudeBin())
    ipcMain.handle('claude:ai-title', (_e, cwd: string, uuid: string) => readAiTitle(cwd, uuid))
    ipcMain.handle('sessions:get-titles', () => getSessionTitles())
    ipcMain.handle('app:get-startup-cwd', () => process.cwd())
    // Explicit "open in the OS browser" affordance — used by the external-link button on the
    // web card, since every other window.open in the renderer now routes to an internal card.
    ipcMain.handle('app:open-external', (_e, url: string) => shell.openExternal(url))
    // Reverse-lookup for card:// URLs intercepted by will-navigate inside embedded card pages.
    ipcMain.handle('app:card-url-to-path', (_e, url: string) => cardUrlToAbsPath(url))

    // Packaged: getAppPath() is .../app.asar, but claude spawns dk-mcp with a plain
    // `node` (no asar support), so point at the unpacked copy (see asarUnpack bin/**).
    const appBase = app.isPackaged
      ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
      : app.getAppPath()
    const dkMcpPath = join(appBase, 'bin', 'dky-mcp')
    void ensureDeckMcpRegistered(dkMcpPath).catch((err) => {
      console.warn('[mcp-installer] failed to register:', err)
    })
    void ensureDeckInstruction().catch((err) => {
      console.warn('[claude-md-installer] failed to write CLAUDE.md:', err)
    })
    void ensureDeckyHooks().catch((err) => {
      console.warn('[hooks-installer] failed to write settings.json:', err)
    })

    // Packaged macOS apps use build/icon.icns; in dev the dock falls back to the
    // default Electron icon unless we set it explicitly.
    if (process.platform === 'darwin') app.dock?.setIcon(icon)

    diag('creating window')
    createWindow()
    diag('createWindow returned')

    // Reconexão automática de tunnels SSH em background: pra cada engine server persistido
    // com sshHost, dispara doOpenRemote silencioso. Quando o tunnel volta vivo, broadcasta
    // engines:updated pro preload trocar a url morta pela nova. NÃO bloqueia o boot — engine
    // fica com url stale por alguns segundos, depois reconecta. Falhas silenciosas (host
    // offline) deixam a engine com url velha — user vai ver erro real ao tentar usar.
    void reconnectAllRemoteEngines()

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    diag('whenReady handler completed')
  })
  .catch((err) => {
    diag(`whenReady REJECTED: ${err?.stack || err}`)
  })

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Block the actual exit until the renderer flushes the current workspace state — otherwise
// the debounced save (400ms) drops the tail and a just-created session is lost on quit.
let didFlush = false
app.on('before-quit', (e) => {
  if (didFlush) return // second pass (after flush) — let the quit proceed
  didFlush = true
  killAllPtys()
  stopPreviewServer()
  // Best-effort close do WS server. Não bloqueia o quit — sessions WS fechadas pelo OS de qualquer jeito.
  void wsServer?.close().catch(() => {})
  wsServer = null
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  e.preventDefault()
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    ipcMain.removeListener('app:flush-done', finish)
    app.quit() // re-quit; didFlush is now true so this pass falls through
  }
  ipcMain.once('app:flush-done', finish)
  win.webContents.send('app:flush')
  setTimeout(finish, 1500) // safety: never hang quit if the renderer can't ack
})

process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

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
import { LOCAL_ENGINE_ID, serializeEngines, type Engine } from '@decky/shared'
import { registerPtyHandlers, killAllPtys } from './pty'
import {
  startPreviewServer,
  stopPreviewServer,
  getPreviewSources,
  getSessionTitles,
  rehydratePreviews
} from './preview-server'
import { registerLegacyIpcBridges } from './legacy-ipc'
import { registerCardsHandlers } from './cards-store'
import { registerTagsIndexHandlers } from './tags-index-watcher'
import { searchCards, pinSessionTitle } from '@decky/server'
import { resolveWikilink, computeBacklinks } from '@decky/server'
import { workspaceCardsDir } from '@decky/shared/node'
import { registerCardMirrorHandlers } from './card-mirror'
import { registerWidgetBridge, setCardBridgeWsUrl } from '@decky/server'
import { migrateGlobalState } from '@decky/server'
import { registerFileWatchHandlers } from './file-watcher'
import { ensureDeckMcpRegistered } from '@decky/server'
import { removeDeckInstruction } from '@decky/server'
import { ensureDeckyHooks } from '@decky/server'
import { registerStateWsHandlers, getState } from '@decky/server'
import { registerGitWsHandlers } from '@decky/server'
import { registerWorkspaceWsHandlers } from '@decky/server'
import { registerTagsIndexWsHandlers } from '@decky/server'
import { registerHistoryWsHandlers } from '@decky/server'
import { registerCardsExtraWsHandlers } from '@decky/server'
import { listClaudeSessions, deleteClaudeSession, type ClaudeSessionInfo } from '@decky/server'
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
app.commandLine.appendSwitch(
  'disable-features',
  'FedCm,FedCmAuthz,FedCmIdpSigninStatusEnabled,FedCmAutoSelectedFlag'
)

let mainWindow: BrowserWindow | null = null
let wsServer: DeckyWsServer | null = null
// Só existe o engine `local` — o server embarcado (loopback WS), montado no boot e passado pro
// preload via --decky-engines argv. (O modo standalone/remoto via SSH foi removido.)
let rendererEngines: Engine[] = []

function buildEngineList(): Engine[] {
  const local: Engine = {
    id: LOCAL_ENGINE_ID,
    kind: 'local',
    label: 'local',
    url: wsServer?.url ?? ''
  }
  return [local]
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
    mainWindow.webContents.send('session:add', { cwd: dir })
    wsServer?.broadcast('session:add', { cwd: dir })
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
      // --decky-engines: o engine `local` (loopback WS do server embarcado). O preload abre a
      // conexão WS a partir dela. Mantém --decky-ws-url=<local> por compat (back-compat no
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

    Menu.setApplicationMenu(
      buildMenu(
        () => mainWindow,
        () => wsServer
      )
    )

    registerPtyHandlers(
      () => mainWindow,
      () => wsServer
    )
    registerLegacyIpcBridges()

    // Engine local — o server embarcado (loopback WS). O preload abre a conexão WS a partir dele.
    {
      try {
        wsServer = await startWsServer()
        diag(`[ws-server] listening on ${wsServer.url}`)
        setCardBridgeWsUrl(wsServer.url)
        registerStateWsHandlers(wsServer)
        registerGitWsHandlers(wsServer)
        registerWorkspaceWsHandlers(wsServer)
        registerTagsIndexWsHandlers(wsServer)
        // cards:* extras (search/resolve-wikilink/backlinks) vivem em @decky/server.
        registerCardsExtraWsHandlers(wsServer)
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
        // sessions:set-title — rename manual da aba (duplo-clique). FIXA o título: o aiTitle do claude
        // para de sobrescrever. Título vazio desfixa e volta pro aiTitle/1º-prompt.
        wsServer.handle<{ id: string; title: string }, boolean>('sessions:set-title', (args) => {
          pinSessionTitle(args?.id ?? '', args?.title ?? '')
          return true
        })
        // claudeSessions:list — conversas do claude no disco pra este cwd (aiTitle, branch, mtime).
        // O renderer usa pra reconciliar o título das abas abertas + montar o picker de anteriores.
        wsServer.handle<{ cwd: string }, ClaudeSessionInfo[]>('claudeSessions:list', (args) =>
          listClaudeSessions(args?.cwd ?? '')
        )
        // claudeSessions:delete — apaga DEFINITIVAMENTE o .jsonl da conversa (o "x" do picker).
        wsServer.handle<{ cwd: string; id: string }, void>('claudeSessions:delete', (args) =>
          deleteClaudeSession(args?.cwd ?? '', args?.id ?? '')
        )
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
    // Resolve o engine local ANTES de createWindow — o argv --decky-engines sai daqui.
    rendererEngines = buildEngineList()
    diag(`[engines] ${rendererEngines.map((e) => `${e.id}(${e.kind})`).join(', ')}`)
    registerCardsHandlers(() => wsServer)
    registerTagsIndexHandlers()
    registerCardMirrorHandlers(
      () => mainWindow,
      () => wsServer
    )
    registerWidgetBridge(() => wsServer)
    registerFileWatchHandlers(
      () => mainWindow,
      () => wsServer
    )
    registerDevRebuildHandlers(
      () => mainWindow,
      () => wsServer
    )
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
    // DIAG temporário: o renderer reporta aqui quando o terminal perde o foco, pra registrarmos no
    // decky-startup.log (o console do renderer não vai pra lá). Caçando o "foco vai embora do nada".
    ipcMain.on('app:diag', (_e, msg: string) => diag(`[focus] ${msg}`))
    setupWebSession(() => mainWindow)
    attachWebContentsPopupRouter(() => mainWindow)
    setupHistory()
    setupWebViews(() => mainWindow)
    setupHtmlServer(() => wsServer)
    diag('handlers registered, starting preview server')
    startPreviewServer(
      () => mainWindow,
      () => wsServer
    )

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
    wsServer?.handle<{ id: string; title: string; body?: string }, void>('notify:show', (payload) =>
      showNotification(payload ?? { id: '', title: '' })
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
    ipcMain.handle('sessions:get-titles', () => getSessionTitles())
    ipcMain.handle('sessions:set-title', (_e, args: { id: string; title: string }) =>
      pinSessionTitle(args?.id ?? '', args?.title ?? '')
    )
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
    // Expõe o dir de bins (dky/dky-mcp/decky) pro pty-manager prefixar no PATH SÓ das sessões —
    // assim o `decky` só existe dentro dos terminais do decky, nunca no PATH global do sistema.
    process.env.DECKY_BIN_DIR = join(appBase, 'bin')
    void ensureDeckMcpRegistered(dkMcpPath).catch((err) => {
      console.warn('[mcp-installer] failed to register:', err)
    })
    // A instrução decky migrou pro hook de SessionStart (decky claude-context). Aqui só limpamos
    // qualquer bloco antigo deixado no ~/.claude/CLAUDE.md global por versões anteriores.
    void removeDeckInstruction().catch((err) => {
      console.warn('[claude-md-installer] failed to clean CLAUDE.md:', err)
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
  if (didFlush) return // já estamos no shutdown — não re-entra
  didFlush = true
  // SEMPRE seguramos o quit e dirigimos o shutdown nós mesmos: 1) flush do workspace, 2) drena os
  // ptys (espera o onExit pra liberar a ThreadSafeFunction do node-pty — ver killAllPtys), 3) só
  // então app.exit(0). Sem o drain, o teardown do env Node roda com um callback do pty pendente e
  // aborta (SIGABRT → "decky quit unexpectedly"). app.exit pula o teardown gracioso; o relaunch do
  // dev-rebuild continua valendo (Electron: relaunch dispara em app.quit OU app.exit).
  e.preventDefault()

  stopPreviewServer()
  // Best-effort close do WS server. Não bloqueia o quit — sessions WS fechadas pelo OS de qualquer jeito.
  void wsServer?.close().catch(() => {})
  wsServer = null

  const flushRenderer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const win = mainWindow
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return resolve()
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener('app:flush-done', finish)
        resolve()
      }
      ipcMain.once('app:flush-done', finish)
      win.webContents.send('app:flush')
      setTimeout(finish, 1500) // safety: never hang quit if the renderer can't ack
    })

  void (async () => {
    await flushRenderer()
    await killAllPtys() // espera os ptys morrerem → TSFN liberada antes do exit
    app.exit(0)
  })()
})

process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

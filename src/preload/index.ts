import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { PreviewSource } from '@decky/shared'
import type { CliKind, DetectedCli, CliInstallHint } from '@decky/shared'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX, normalizeLocale, type Locale } from '@decky/shared'
import { LOCAL_ENGINE_ID, type Engine } from '@decky/shared'
import { wsInvoke, wsOn, wsSend, listEngines, upsertEngine, removeEngine } from './ws-client'

const resolvedLocale: Locale = (() => {
  const arg = process.argv.find((a) => a.startsWith(LOCALE_ARG_PREFIX))
  return arg ? normalizeLocale(arg.slice(LOCALE_ARG_PREFIX.length)) : DEFAULT_LOCALE
})()

// Roteamento por engine. O renderer empurra os mapas (workspace cwd → engineId, session id →
// engineId) via deck.engines.setRoutes sempre que a lista de workspaces/sessions muda. Tudo que
// não estiver mapeado cai no 'local' (default seguro: legado e shell-global).
const wsRoutes: Record<string, string> = {}
const sessionRoutes: Record<string, string> = {}
function engineForWorkspace(ws: string | null | undefined): string {
  return (ws && wsRoutes[ws]) || LOCAL_ENGINE_ID
}
function engineForSession(id: string): string {
  return sessionRoutes[id] || LOCAL_ENGINE_ID
}
// Atalho pros muitos handlers shell-global que vivem sempre no engine local.
const L = LOCAL_ENGINE_ID

// --- pty fan-in (Bloco 2) ---------------------------------------------------------------------
// pty.onData/onExit são registrados UMA vez (não por sessão), mas sessões remotas streamam o
// terminal via broadcast WS do engine dono. Aqui agregamos: um Set de callbacks + assinatura
// por engine remoto que faz dispatch (a msg já carrega o id da sessão; o renderer roteia por id).
// O caminho local segue por ipcRenderer (webContents.send), inalterado.
type PtyDataMsg = { id: string; data: string }
type PtyExitMsg = { id: string; code: number }
const ptyDataCbs = new Set<(m: PtyDataMsg) => void>()
const ptyExitCbs = new Set<(m: PtyExitMsg) => void>()
const ptySubscribedEngines = new Set<string>()
function subscribeEnginePty(engineId: string): void {
  if (engineId === L || ptySubscribedEngines.has(engineId)) return
  ptySubscribedEngines.add(engineId)
  wsOn<PtyDataMsg>(engineId, 'pty:data', (m) => ptyDataCbs.forEach((cb) => cb(m)))
  wsOn<PtyExitMsg>(engineId, 'pty:exit', (m) => ptyExitCbs.forEach((cb) => cb(m)))
}
// Assina os engines remotos já conhecidos no boot. Os adicionados em runtime são assinados em
// deck.engines.add → subscribeEnginePty.
for (const e of listEngines()) subscribeEnginePty(e.id)

// Reconexão automática: o main dispara doOpenRemote em background pra cada engine remoto no
// boot e emite 'engines:updated' (no engine local) quando o tunnel volta vivo. Aqui escutamos
// e fazemos upsertEngine, que troca a url+token cacheados e força reconexão da WS — sem isso,
// o renderer continuaria tentando a porta morta de um tunnel anterior.
wsOn<Engine>(L, 'engines:updated', (engine) => {
  upsertEngine(engine)
  subscribeEnginePty(engine.id)
})

const deckApi = {
  pty: {
    // Sessão local → ipcRenderer (pty no main local). Sessão de server → wsInvoke/wsSend no
    // engine dono (pty roda no host remoto via pty-manager do decky-server). O engine é resolvido
    // por engineForSession(id); o renderer registra a rota da sessão ANTES do create.
    create: (
      id: string,
      opts: { cwd?: string; cols: number; rows: number; shell?: string; command?: string[] }
    ): Promise<void> => {
      const eng = engineForSession(id)
      if (eng === L) return ipcRenderer.invoke('pty:create', { id, ...opts })
      return wsInvoke(eng, 'pty:create', { id, ...opts })
    },
    write: (id: string, data: string): void => {
      const eng = engineForSession(id)
      if (eng === L) ipcRenderer.send('pty:write', { id, data })
      else void wsSend(eng, 'pty:write', { id, data })
    },
    resize: (id: string, cols: number, rows: number): void => {
      const eng = engineForSession(id)
      if (eng === L) ipcRenderer.send('pty:resize', { id, cols, rows })
      else void wsSend(eng, 'pty:resize', { id, cols, rows })
    },
    kill: (id: string): void => {
      const eng = engineForSession(id)
      if (eng === L) ipcRenderer.send('pty:kill', { id })
      else void wsSend(eng, 'pty:kill', { id })
    },
    // Fan-in: local via ipcRenderer + cada engine remoto via subscribeEnginePty. O renderer
    // roteia por id, então um único callback recebe data/exit de TODAS as sessões.
    onData: (callback: (msg: PtyDataMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyDataMsg): void => callback(msg)
      ipcRenderer.on('pty:data', listener)
      ptyDataCbs.add(callback)
      return () => {
        ipcRenderer.removeListener('pty:data', listener)
        ptyDataCbs.delete(callback)
      }
    },
    onExit: (callback: (msg: PtyExitMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyExitMsg): void => callback(msg)
      ipcRenderer.on('pty:exit', listener)
      ptyExitCbs.add(callback)
      return () => {
        ipcRenderer.removeListener('pty:exit', listener)
        ptyExitCbs.delete(callback)
      }
    }
  },
  preview: {
    getAll: (): Promise<Record<string, PreviewSource>> => wsInvoke(L, 'preview:get-all'),
    rehydrate: (
      byCard: Record<string, Record<string, PreviewSource>>,
      workspace?: string
    ): Promise<Record<string, Record<string, PreviewSource>>> =>
      wsInvoke(L, 'preview:rehydrate', { byCard, workspace }),
    onSourceChange: (
      callback: (msg: {
        sessionId: string
        cardId: string | null
        source: PreviewSource
        reqId?: string
      }) => void
    ): (() => void) =>
      wsOn<{ sessionId: string; cardId: string | null; source: PreviewSource; reqId?: string }>(
        L,
        'preview:source-changed',
        callback
      ),
    // Ack a preview:source-changed broadcast: tell server which card the inline source actually
    // landed on so the HTTP /preview response can echo cardId+path back to the MCP caller.
    resolved: (payload: { reqId: string; cardId: string; path?: string; title?: string }): void => {
      void wsSend(L, 'preview:resolved', payload)
    }
  },
  workspace: {
    read: <T = unknown>(cwd: string): Promise<T | null> =>
      wsInvoke<T | null>(engineForWorkspace(cwd), 'workspace:read', { cwd }),
    write: (cwd: string, state: unknown): Promise<boolean> =>
      wsInvoke(engineForWorkspace(cwd), 'workspace:write', { cwd, state })
  },
  cards: {
    // Materialize a card to its file under the workspace's .decky/cards/. Returns the
    // resolved abs path (to store on the source + watch), or null on failure.
    write: (
      workspace: string,
      cardId: string,
      content: string,
      ext?: '.md' | '.html'
    ): Promise<string | null> =>
      wsInvoke(engineForWorkspace(workspace), 'cards:write', { workspace, cardId, content, ext }),
    // Push the renderer's full per-session card mirror to main (id/path/title/type/focused).
    // Main exposes this via HTTP for the MCP list_cards tool. Sempre no local (mirror p/ MCP local).
    syncState: (sessions: Record<string, unknown>): void => {
      void wsSend(L, 'cards:state-sync', { sessions })
    },
    // List every .md page under <workspace>/.decky/cards/ (recursive). Drives the
    // "Páginas do workspace" panel.
    list: (
      workspace: string
    ): Promise<{ id: string; path: string; title: string; mtime: number }[]> =>
      wsInvoke(engineForWorkspace(workspace), 'cards:list', { workspace }),
    // Full-text search across <workspace>/.decky/cards/ (recursive). Empty query
    // returns the most-recently-modified cards by mtime.
    search: (
      workspace: string,
      query: string,
      limit?: number
    ): Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        score: number
        mtime: number
      }[]
    > => wsInvoke(engineForWorkspace(workspace), 'cards:search', { workspace, query, limit }),
    // Resolve a [[name]] wikilink to an absolute card path under <workspace>/.decky/cards/.
    // Returns null if no card matches by full id or basename.
    resolveWikilink: (workspace: string, name: string): Promise<string | null> =>
      wsInvoke(engineForWorkspace(workspace), 'cards:resolve-wikilink', { workspace, name }),
    // List every card whose body contains [[<id>]] or [[<basename>]] pointing at cardPath.
    backlinks: (
      workspace: string,
      cardPath: string
    ): Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        mtime: number
      }[]
    > => wsInvoke(engineForWorkspace(workspace), 'cards:backlinks', { workspace, cardPath }),
    delete: (workspace: string, cardId: string): Promise<boolean> =>
      wsInvoke(engineForWorkspace(workspace), 'cards:delete', { workspace, cardId })
  },
  tagsIndex: {
    // Ensure the workspace's tags-index.html is being generated + watched. Idempotent.
    // Triggers an initial generation on the first call so the index file exists when the
    // renderer goes to open it as an empty-state tab.
    ensure: (workspace: string): Promise<void> =>
      wsInvoke(engineForWorkspace(workspace), 'tagsIndex:ensure', { workspace }),
    // Force a regen now (sync — useful from a UI "rebuild index" button later).
    rebuild: (workspace: string): Promise<void> =>
      wsInvoke(engineForWorkspace(workspace), 'tagsIndex:rebuild', { workspace }),
    // Absolute path to <workspace>/.decky[-dev]/cards/tags-index.html.
    path: (workspace: string): Promise<string> =>
      wsInvoke(engineForWorkspace(workspace), 'tagsIndex:path', { workspace })
  },
  file: {
    // file:* opera em paths crus; o renderer informa o engine do workspace dono via 3º arg
    // (default local — onde vivem os arquivos de card locais). watch/onChanged ficam no local.
    watch: (path: string): Promise<boolean> => wsInvoke(L, 'file:watch', { path }),
    unwatch: (path: string): Promise<boolean> => wsInvoke(L, 'file:unwatch', { path }),
    readText: (path: string, workspace?: string): Promise<string | null> =>
      wsInvoke(engineForWorkspace(workspace), 'file:read-text', { path }),
    // readBinary fica em IPC enquanto o protocolo WS não carrega binário (base64 ou frames).
    readBinary: (path: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke('file:read-binary', path),
    write: (path: string, content: string, workspace?: string): Promise<boolean> =>
      wsInvoke(engineForWorkspace(workspace), 'file:write', { path, content }),
    // Binary write via base64. Usado pelo paste de imagem em sessão remota: o terminal
    // intercepta paste, encode a PNG e chama isto pra subir pro engine dono (PI ou local).
    writeBinaryBase64: (path: string, base64: string, workspace?: string): Promise<boolean> =>
      wsInvoke(engineForWorkspace(workspace), 'file:write-binary-base64', { path, base64 }),
    onChanged: (callback: (msg: { path: string }) => void): (() => void) =>
      wsOn<{ path: string }>(L, 'file:changed', callback)
  },
  claude: {
    getBin: (): Promise<string> => wsInvoke(L, 'claude:get-bin'),
    aiTitle: (cwd: string, uuid: string): Promise<string | null> =>
      wsInvoke(engineForWorkspace(cwd), 'claude:ai-title', { cwd, uuid })
  },
  git: {
    diffStats: (
      cwd: string
    ): Promise<{ isRepo: boolean; additions: number; deletions: number; branch?: string }> =>
      wsInvoke(engineForWorkspace(cwd), 'git:diff-stats', { cwd }),
    diffText: (cwd: string): Promise<string> =>
      wsInvoke(engineForWorkspace(cwd), 'git:diff-text', { cwd })
  },
  // Fase 2 — 1º domínio migrado pro WS. Os 10 handlers `cli:*` vão via wsInvoke; renderer não
  // muda (mesma forma de Promise). Os ipcMain.handle('cli:*') no main continuam registrados
  // mas viram redundantes — saem quando todos os domínios migrarem.
  cli: {
    list: (): Promise<DetectedCli[]> => wsInvoke(L, 'cli:list'),
    recheck: (): Promise<DetectedCli[]> => wsInvoke(L, 'cli:recheck'),
    installHints: (): Promise<CliInstallHint[]> => wsInvoke(L, 'cli:install-hints'),
    getDefault: (): Promise<CliKind | null> => wsInvoke(L, 'cli:get-default'),
    setDefault: (kind: CliKind): Promise<boolean> => wsInvoke(L, 'cli:set-default', { kind }),
    isFirstRun: (): Promise<boolean> => wsInvoke(L, 'cli:is-first-run'),
    markFirstRunDone: (): Promise<boolean> => wsInvoke(L, 'cli:mark-first-run-done'),
    getPaths: (): Promise<Partial<Record<CliKind, string>>> => wsInvoke(L, 'cli:get-paths'),
    setPath: (kind: CliKind, path: string | null): Promise<DetectedCli[]> =>
      wsInvoke(L, 'cli:set-path', { kind, path }),
    validatePath: (path: string): Promise<{ ok: boolean; error?: string; version?: string }> =>
      wsInvoke(L, 'cli:validate-path', { path })
  },
  sessions: {
    getTitles: (): Promise<Record<string, string>> => wsInvoke(L, 'sessions:get-titles'),
    onTitleChange: (callback: (msg: { id: string; title: string }) => void): (() => void) =>
      wsOn<{ id: string; title: string }>(L, 'session:title-changed', callback),
    onAdd: (callback: (msg: { cwd: string; kind: 'claude' | 'shell' }) => void): (() => void) =>
      wsOn<{ cwd: string; kind: 'claude' | 'shell' }>(L, 'session:add', callback),
    onUuidConflict: (callback: (msg: { id: string }) => void): (() => void) =>
      wsOn<{ id: string }>(L, 'session:uuid-conflict', callback)
  },
  app: {
    locale: resolvedLocale,
    getStartupCwd: (): Promise<string> => ipcRenderer.invoke('app:get-startup-cwd'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
    pickFile: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pick-file', title),
    onMenuNewSession: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:new-session', listener)
      return () => ipcRenderer.removeListener('menu:new-session', listener)
    },
    onMenuCloseTab: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:close-tab', listener)
      return () => ipcRenderer.removeListener('menu:close-tab', listener)
    },
    onMenuTogglePalette: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:toggle-palette', listener)
      return () => ipcRenderer.removeListener('menu:toggle-palette', listener)
    },
    onMenuToggleFind: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:toggle-find', listener)
      return () => ipcRenderer.removeListener('menu:toggle-find', listener)
    },
    onMenuOpenCliSettings: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:open-cli-settings', listener)
      return () => ipcRenderer.removeListener('menu:open-cli-settings', listener)
    },
    onMenuAddServer: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:add-server', listener)
      return () => ipcRenderer.removeListener('menu:add-server', listener)
    },
    onMenuDevRebuild: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:dev-rebuild', listener)
      return () => ipcRenderer.removeListener('menu:dev-rebuild', listener)
    },
    // Quit-time flush: main sends 'app:flush' and holds the exit until we reply 'app:flush-done'.
    onFlush: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('app:flush', listener)
      return () => ipcRenderer.removeListener('app:flush', listener)
    },
    flushDone: (): void => ipcRenderer.send('app:flush-done'),
    // Main forwards every link click / window.open from the renderer here so we can spawn an
    // internal web card instead of leaking to the OS browser.
    onOpenUrl: (callback: (url: string) => void): (() => void) => {
      const listener = (_: unknown, url: string): void => callback(url)
      ipcRenderer.on('app:open-url', listener)
      return () => ipcRenderer.removeListener('app:open-url', listener)
    },
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
    cardUrlToPath: (url: string): Promise<string | null> =>
      ipcRenderer.invoke('app:card-url-to-path', url),
    // Main forwards decky chrome shortcuts (Cmd+P etc) caught by focused web cards so the
    // renderer can replay them as a real KeyboardEvent on window.
    onShortcut: (
      callback: (msg: {
        key: string
        shift: boolean
        control: boolean
        alt: boolean
        meta: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: { key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean }
      ): void => callback(msg)
      ipcRenderer.on('app:shortcut', listener)
      return () => ipcRenderer.removeListener('app:shortcut', listener)
    }
  },
  dev: {
    getInfo: (): Promise<{ enabled: boolean; repo?: string; accel: string }> =>
      wsInvoke(L, 'dev:get-info'),
    // dev:rebuild runs electron-vite + (often) electron-builder + codesign — easily blows past
    // the wsInvoke 10s default. Give it a generous ceiling that still bounds runaway behavior.
    rebuild: (): Promise<{ ok: boolean; error?: string }> =>
      wsInvoke(L, 'dev:rebuild', undefined, { timeoutMs: 10 * 60 * 1000 }),
    relaunch: (): Promise<void> => wsInvoke(L, 'dev:relaunch'),
    onOutput: (callback: (line: string) => void): (() => void) =>
      wsOn<string>(L, 'dev:rebuild-output', callback)
  },
  state: {
    get: <T = unknown>(key: string): Promise<T | null> =>
      wsInvoke<T | null>(L, 'state:get', { key }),
    set: (key: string, value: unknown): Promise<boolean> => wsInvoke(L, 'state:set', { key, value })
  },
  theme: {
    // Tells main to set Electron's nativeTheme.themeSource so every embedded webContents
    // (each web card) reports the matching prefers-color-scheme. Call on every renderer
    // mode toggle.
    setMode: (mode: 'dark' | 'light'): Promise<boolean> => wsInvoke(L, 'theme:set-mode', { mode })
  },
  notify: {
    show: (payload: { id: string; title: string; body?: string }): Promise<void> =>
      wsInvoke(L, 'notify:show', payload),
    onFocusSession: (callback: (msg: { id: string }) => void): (() => void) =>
      wsOn<{ id: string }>(L, 'notify:focus-session', callback)
  },
  web: {
    // Each web card maps 1:1 to a WebContentsView owned by main. The renderer creates the
    // view on mount, streams bounds whenever its sentinel rect changes, hides it (zero-sized
    // bounds) when the pane / session / overlay state says it shouldn't be visible, and
    // destroys it on unmount.
    create: (cardId: string, url: string, workspaceCwd?: string | null): Promise<true> =>
      ipcRenderer.invoke('web:create', { cardId, url, workspaceCwd: workspaceCwd ?? null }),
    destroy: (cardId: string): Promise<true> => ipcRenderer.invoke('web:destroy', cardId),
    setBounds: (
      cardId: string,
      bounds: { x: number; y: number; width: number; height: number }
    ): void => ipcRenderer.send('web:set-bounds', { cardId, bounds }),
    hide: (cardId: string): void => ipcRenderer.send('web:hide', cardId),
    navigate: (cardId: string, url: string): void =>
      ipcRenderer.send('web:navigate', { cardId, url }),
    back: (cardId: string): void => ipcRenderer.send('web:back', cardId),
    forward: (cardId: string): void => ipcRenderer.send('web:forward', cardId),
    reload: (cardId: string): void => ipcRenderer.send('web:reload', cardId),
    stop: (cardId: string): void => ipcRenderer.send('web:stop', cardId),
    openDevTools: (cardId: string): void => ipcRenderer.send('web:open-devtools', cardId),
    getState: (
      cardId: string
    ): Promise<{
      url: string
      title: string
      favicon: string | null
      loading: boolean
      canBack: boolean
      canFwd: boolean
    } | null> => ipcRenderer.invoke('web:get-state', cardId),
    onState: (
      callback: (msg: {
        cardId: string
        url: string
        title: string
        favicon: string | null
        loading: boolean
        canBack: boolean
        canFwd: boolean
      }) => void
    ): (() => void) => {
      const listener = (_: unknown, msg: Parameters<typeof callback>[0]): void => callback(msg)
      ipcRenderer.on('web:state', listener)
      return () => ipcRenderer.removeListener('web:state', listener)
    },
    // Estado vivo "agente está dirigindo este card". O backend do handoff (handoff-backend.ts)
    // liga/desliga; o renderer reage com animação + bounds shrunk pra mostrar a borda.
    getControlling: (cardId: string): Promise<boolean> =>
      ipcRenderer.invoke('web:get-controlling', cardId),
    onControlling: (
      callback: (msg: { cardId: string; controlling: boolean }) => void
    ): (() => void) => {
      const listener = (_: unknown, msg: Parameters<typeof callback>[0]): void => callback(msg)
      ipcRenderer.on('web:controlling', listener)
      return () => ipcRenderer.removeListener('web:controlling', listener)
    },
    // Main asks renderer to open a card:// URL as a NEW decky tab (with de-dup) instead of
    // navigating the WebContentsView away from the current page. Triggered by `will-navigate`
    // inside the embedded card pages.
    onOpenTab: (callback: (msg: { url: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { url: string }): void => callback(msg)
      ipcRenderer.on('card:open-tab', listener)
      return () => ipcRenderer.removeListener('card:open-tab', listener)
    }
  },
  html: {
    // Hoje resolve um path local pra URL card:// (o servidor HTTP loopback antigo virou code morto).
    // O nome "resolve" sobreviveu pela compatibilidade com a chamada do renderer.
    resolve: (path: string): Promise<string> => wsInvoke(L, 'html:resolve', { path })
  },
  history: {
    listRecent: (
      workspaceCwd: string | null,
      limit?: number
    ): Promise<
      {
        id: number
        url: string
        title: string | null
        favicon: string | null
        card_id: string | null
        workspace_id: string
        visited_at: number
        dwell_ms: number
        transition: string | null
      }[]
    > => wsInvoke(L, 'history:list-recent', { workspaceCwd, limit }),
    // Address-bar autocomplete: query vazia = top por frecência geral.
    suggest: (
      workspaceCwd: string | null,
      query: string,
      limit?: number
    ): Promise<
      {
        url: string
        title: string | null
        favicon: string | null
        hits: number
        last_visited: number
      }[]
    > => wsInvoke(L, 'history:suggest', { workspaceCwd, query, limit }),
    getWorkspaceMeta: (cwd: string): Promise<{ workspaceId: string; isolated: boolean }> =>
      wsInvoke(L, 'history:get-workspace-meta', { cwd }),
    setWorkspaceIsolated: (cwd: string, isolated: boolean): Promise<boolean> =>
      wsInvoke(L, 'history:set-workspace-isolated', { cwd, isolated })
  },
  ssh: {
    exec: (args: {
      host: string
      command: string
      identity?: string
      timeoutMs?: number
    }): Promise<{
      ok: boolean
      exitCode: number | null
      stdout: string
      stderr: string
      error?: string
    }> => wsInvoke(L, 'ssh:exec', args),
    installDeckyServer: (args: {
      host: string
      identity?: string
    }): Promise<{ ok: boolean; error?: string }> =>
      // npm install no RP4 pode demorar minutos — sobe pra 10min.
      wsInvoke(L, 'ssh:install-decky-server', args, { timeoutMs: 10 * 60 * 1000 }),
    openRemote: (args: {
      host: string
      identity?: string
    }): Promise<{ ok: boolean; localUrl?: string; token?: string; error?: string }> =>
      // start + wait token + tunnel ~5-15s, mas dá margem.
      wsInvoke(L, 'ssh:open-remote', args, { timeoutMs: 60_000 }),
    onInstallProgress: (
      cb: (
        ev:
          | {
              kind: 'step'
              step: { id: string; state: 'pending' | 'running' | 'ok' | 'error'; detail?: string }
            }
          | { kind: 'log'; line: string }
          | { kind: 'done'; ok: boolean; error?: string }
      ) => void
    ): (() => void) => wsOn(L, 'ssh:install-progress', cb)
  },
  // Multi-engine: lista/adiciona engines (local + servers). "Add server" chama add() em vez do
  // antigo reopen-with-remote (que relançava e escondia o local). add() persiste o server no
  // state do main, registra a conexão em runtime (sem relaunch) e devolve o engine pro renderer
  // inserir na árvore. setRoutes empurra os mapas workspace/session → engineId pro roteamento.
  engines: {
    list: (): Engine[] => listEngines(),
    add: async (cfg: {
      label: string
      url: string
      token?: string
      sshHost?: string
      sshIdentity?: string
    }): Promise<Engine> => {
      const engine = await wsInvoke<Engine>(L, 'engines:add', cfg)
      upsertEngine(engine)
      subscribeEnginePty(engine.id)
      return engine
    },
    remove: async (engineId: string): Promise<boolean> => {
      // Avisa o backend (engines:remove no main persiste no state e desfaz a entrada).
      const ok = await wsInvoke<boolean>(L, 'engines:remove', { engineId })
      // Limpa a cache do preload — list() e wsInvoke(engineId,...) param de reconhecer o engine.
      // Sem isso, App.tsx chamava engines.list() e ainda via o engine removido, então
      // setEngines não mudava nada e a UI parecia "não remover".
      removeEngine(engineId)
      return ok
    },
    setRoutes: (routes: {
      workspaces?: Record<string, string>
      sessions?: Record<string, string>
    }): void => {
      if (routes.workspaces) {
        for (const k of Object.keys(wsRoutes)) delete wsRoutes[k]
        Object.assign(wsRoutes, routes.workspaces)
      }
      if (routes.sessions) {
        for (const k of Object.keys(sessionRoutes)) delete sessionRoutes[k]
        Object.assign(sessionRoutes, routes.sessions)
      }
    },
    // Notifica o renderer quando um engine remoto reconecta (tunnel SSH novo + URL/token
    // novos via reconnectAllRemoteEngines). O preload já chama upsertEngine internamente,
    // mas o React precisa saber pra re-disparar effects que dependem de engines (ex: re-ler
    // workspace.read dos workspaces remotos quando a conexão volta).
    onUpdate: (callback: (engine: Engine) => void): (() => void) =>
      wsOn<Engine>(L, 'engines:updated', callback),
    // Síncrono — devolve engineId da sessão (default LOCAL). Usado por componentes que precisam
    // distinguir comportamento local vs remoto sem fan-out (ex: paste de imagem no Terminal).
    engineForSession: (id: string): string => engineForSession(id)
  },
  widget: {
    // Server forwards every widget:call here. The renderer dispatches into the widget registry
    // and acks via reply(reqId, ...). One-shot per reqId — there is no streaming.
    onCall: (
      callback: (msg: {
        reqId: string
        kind: 'invoke' | 'get' | 'list'
        cardId?: string
        widgetId?: string
        op?: string
        args?: unknown
        key?: string
      }) => void
    ): (() => void) =>
      wsOn<{
        reqId: string
        kind: 'invoke' | 'get' | 'list'
        cardId?: string
        widgetId?: string
        op?: string
        args?: unknown
        key?: string
      }>(L, 'widget:call', callback),
    reply: (payload: { reqId: string; result?: unknown; error?: string }): void => {
      void wsSend(L, 'widget:call-reply', payload)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('deck', deckApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.deck = deckApi
}

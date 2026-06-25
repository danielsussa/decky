import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { PreviewSource } from '@decky/shared'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX, normalizeLocale, type Locale } from '@decky/shared'
import { LOCAL_ENGINE_ID } from '@decky/shared'
import { wsInvoke, wsOn, wsSend } from './ws-client'

const resolvedLocale: Locale = (() => {
  const arg = process.argv.find((a) => a.startsWith(LOCALE_ARG_PREFIX))
  return arg ? normalizeLocale(arg.slice(LOCALE_ARG_PREFIX.length)) : DEFAULT_LOCALE
})()

// Só existe o engine `local` — todas as chamadas (workspace, sessão, shell-global) roteiam pra
// ele. As funções abaixo sobrevivem como identidade pra manter os call sites legíveis.
const L = LOCAL_ENGINE_ID
function engineForWorkspace(_ws?: string | null): string {
  return L
}
function engineForSession(_id?: string): string {
  return L
}

type PtyDataMsg = { id: string; data: string }
type PtyExitMsg = { id: string; code: number }
type PtyClaudeMsg = { id: string; running: boolean; sessionId?: string; launchCmd?: string }
type ClaudeSessionInfo = {
  id: string
  title: string | null
  gitBranch: string | null
  lastPrompt: string | null
  mtimeMs: number
}

const deckApi = {
  pty: {
    // Sessão local → ipcRenderer (pty no main local). Sessão de server → wsInvoke/wsSend no
    // engine dono (pty roda no host remoto via pty-manager do decky-server). O engine é resolvido
    // por engineForSession(id); o renderer registra a rota da sessão ANTES do create.
    create: (
      id: string,
      opts: {
        cwd?: string
        cols: number
        rows: number
        shell?: string
        command?: string[]
        claudeSessionId?: string
      }
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
    onData: (callback: (msg: PtyDataMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyDataMsg): void => callback(msg)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (callback: (msg: PtyExitMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyExitMsg): void => callback(msg)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    },
    // claude virou (ou saiu de) foreground do PTY. Usado pra persistir "essa sessão tava com
    // claude" + o id da conversa pra `claude --resume` no próximo boot.
    onClaude: (callback: (msg: PtyClaudeMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyClaudeMsg): void => callback(msg)
      ipcRenderer.on('pty:claude', listener)
      return () => ipcRenderer.removeListener('pty:claude', listener)
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
      wsOn<{
        sessionId: string
        cardId: string | null
        source: PreviewSource
        reqId?: string
      }>(L, 'preview:source-changed', callback),
    // Ack a preview:source-changed broadcast — desbloqueia o POST /preview que originou o reqId.
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
  git: {
    diffStats: (
      cwd: string
    ): Promise<{ isRepo: boolean; additions: number; deletions: number; branch?: string }> =>
      wsInvoke(engineForWorkspace(cwd), 'git:diff-stats', { cwd }),
    diffText: (cwd: string): Promise<string> =>
      wsInvoke(engineForWorkspace(cwd), 'git:diff-text', { cwd })
  },
  sessions: {
    getTitles: (): Promise<Record<string, string>> => wsInvoke(L, 'sessions:get-titles'),
    // Rename manual da aba (duplo-clique). Fixa o título; '' desfixa e volta pro aiTitle.
    setTitle: (id: string, title: string): Promise<boolean> =>
      wsInvoke(L, 'sessions:set-title', { id, title }),
    onTitleChange: (
      callback: (msg: { id: string; title: string; pinned?: boolean }) => void
    ): (() => void) =>
      wsOn<{ id: string; title: string; pinned?: boolean }>(L, 'session:title-changed', callback),
    onRunningChange: (callback: (msg: { id: string; cmd: string }) => void): (() => void) =>
      wsOn<{ id: string; cmd: string }>(L, 'session:running-changed', callback),
    onAdd: (callback: (msg: { cwd: string }) => void): (() => void) =>
      wsOn<{ cwd: string }>(L, 'session:add', callback),
    onWebTab: (callback: (msg: { title?: string }) => void): (() => void) =>
      wsOn<{ title?: string }>(L, 'webtab:new', callback),
    // Conversas do claude guardadas no disco pra este cwd (aiTitle/branch/mtime) — usado pra
    // reconciliar o título das abas abertas + montar o picker de "sessões anteriores".
    listClaude: (cwd: string): Promise<ClaudeSessionInfo[]> =>
      wsInvoke(L, 'claudeSessions:list', { cwd }),
    // Apaga DEFINITIVAMENTE a conversa do claude do disco (o "x" do picker de anteriores).
    deleteClaude: (cwd: string, id: string): Promise<void> =>
      wsInvoke(L, 'claudeSessions:delete', { cwd, id })
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
    // DIAG temporário: reporta perda de foco do terminal pro log do main (caçando o foco que some).
    diag: (msg: string): void => ipcRenderer.send('app:diag', msg),
    // Ping "estou digitando num campo editável" — o main usa pra reverter qualquer card que roube o
    // foco de OS logo em seguida. Throttle no renderer (não precisa 1 por tecla).
    typingPing: (): void => ipcRenderer.send('app:typing-ping'),
    // Main devolveu o foco de OS pra janela depois que um WebContentsView (card) o roubou durante
    // uma carga em background. win.webContents.focus() não recoloca o <textarea> do xterm, então o
    // renderer recoloca no terminal ativo aqui. Ver web-views.guardLoadFocus / returnFocusToRenderer.
    onFocusStolenBack: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('app:focus-stolen-back', listener)
      return () => ipcRenderer.removeListener('app:focus-stolen-back', listener)
    },
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
    // Push-based live reload (POST /cards/reload → main → here): a card whose source file is
    // `path` should re-render. The HtmlPreview for that path calls web.reload(cardId). Decouples
    // the reload from the fs watcher — the action that mutates the card drives the refresh.
    onReload: (callback: (msg: { path: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { path: string }): void => callback(msg)
      ipcRenderer.on('card:reload', listener)
      return () => ipcRenderer.removeListener('card:reload', listener)
    },
    // Incremental live patch (POST /cards/patch → main → here): append/pop a single widget on the
    // card for `path` WITHOUT a full reload (no flicker). The HtmlPreview for that path forwards it
    // to web.patchCard(cardId, …). Falls back to a reload on the CLI side if the server lacks it.
    patchCard: (
      cardId: string,
      patch: { op: string; type?: string; id?: string; spec?: unknown; n?: number }
    ): void => ipcRenderer.send('web:patch', { cardId, patch }),
    onPatch: (
      callback: (msg: {
        path: string
        op: string
        type?: string
        id?: string
        spec?: unknown
        n?: number
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: { path: string; op: string; type?: string; id?: string; spec?: unknown; n?: number }
      ): void => callback(msg)
      ipcRenderer.on('card:patch', listener)
      return () => ipcRenderer.removeListener('card:patch', listener)
    },
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

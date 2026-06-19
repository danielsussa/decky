import { ChevronRight, ChevronDown, Plus, X, History } from 'lucide-react'
import { useState } from 'react'
import type { Mode, Theme } from '@decky/shared'
import { t } from '../lib/i18n'

export interface TreeSession {
  id: string
  label: string
  // claudeSessionId da conversa (quando a aba roda claude) — chave pra recência durável (último
  // turn real lido do .jsonl). Ausente em abas shell puro / sem claude.
  claudeSessionId?: string
}

// Filtro de recência das ABAS na árvore: todas, ativas no último dia, ativas na última hora.
// "Ativa" = último turn real do claude (ou atividade ao vivo) dentro da janela; a aba focada
// nunca é escondida. Filtra as sessões dentro de cada workspace, não os workspaces em si.
export type WsActivityFilter = 'all' | '1d' | '1h'

// Uma conversa do claude guardada no disco (do workspace ativo) que NÃO está aberta como aba —
// candidata a "carregar sessão anterior". Vem de listClaudeSessions (aiTitle/branch/mtime).
export interface PrevClaudeSession {
  id: string
  title: string | null
  gitBranch: string | null
  /** 1º prompt do usuário — fallback de rótulo quando a conversa ainda não tem aiTitle. */
  lastPrompt: string | null
  mtimeMs: number
}

interface WorkspaceTreeProps {
  isFocused?: boolean
  workspaces: string[]
  // Quantas ABAS o filtro de recência está escondendo (0 = nada filtrado). Vira "+N ocultas" no
  // rodapé pra deixar claro que a árvore não mostra tudo.
  hiddenCount?: number
  filter: WsActivityFilter
  onFilterChange: (f: WsActivityFilter) => void
  activeWorkspace: string | null
  activeSessionId?: string
  // Cmd+Arrow nav cursor parked in another workspace; renders as a "hover" highlight
  // that won't switch workspace until Enter commits.
  previewedSession?: { ws: string; id: string } | null
  expanded: string[]
  sessionsByWorkspace: Record<string, TreeSession[]>
  activity: Record<string, { status: string; active: boolean; done: boolean }>
  mode: Mode
  // Resolves each workspace path to its assigned theme (drives the color-coded chip per row).
  themeFor: (path: string | null | undefined) => Theme
  nameOf: (path: string) => string
  // Conversas do claude do workspace ATIVO que não estão abertas (picker "sessões anteriores").
  claudePrev: PrevClaudeSession[]
  onLoadClaudeSession: (sessionId: string) => void
  // "x" do picker: apaga DEFINITIVAMENTE a conversa (some da lista + remove o .jsonl do disco).
  onDeleteClaudeSession: (sessionId: string) => void
  onToggleExpand: (ws: string) => void
  onSelectSession: (ws: string, sessionId: string) => void
  onNewSession: (ws: string) => void
  onCloseSession: (ws: string, sessionId: string) => void
  onCloseWorkspace: (ws: string) => void
}

// The left-panel navigation: WS ▸ SESSION. Each workspace expands to its sessions. Selecting a
// session switches workspace if needed; the terminal renders in TerminalHost below.
export default function WorkspaceTree({
  isFocused,
  workspaces,
  hiddenCount = 0,
  filter,
  onFilterChange,
  activeWorkspace,
  activeSessionId,
  previewedSession,
  expanded,
  sessionsByWorkspace,
  activity,
  mode,
  themeFor,
  nameOf,
  onToggleExpand,
  onSelectSession,
  onNewSession,
  onCloseSession,
  onCloseWorkspace,
  claudePrev,
  onLoadClaudeSession,
  onDeleteClaudeSession
}: WorkspaceTreeProps): React.JSX.Element {
  // Per-workspace toggle for the "sessões anteriores" list (claude conversations not open as tabs).
  const [prevOpenFor, setPrevOpenFor] = useState<Record<string, boolean>>({})
  // Force-show children of the previewed workspace so the highlighted session is visible,
  // without mutating the user's persistent expanded state.
  const visualExpanded =
    previewedSession && !expanded.includes(previewedSession.ws)
      ? [...expanded, previewedSession.ws]
      : expanded

  const renderWorkspace = (ws: string): React.JSX.Element => {
    const isOpen = visualExpanded.includes(ws)
    const isActiveWs = ws === activeWorkspace
    const isPreviewWs = previewedSession?.ws === ws
    const sessions = sessionsByWorkspace[ws] ?? []
    // Each workspace title carries its OWN hue (from the persisted assignment, same as the
    // surface theme when that workspace is active), so the list reads as a color-coded legend.
    const wsAccent = themeFor(ws)[mode].vars['--accent']
    return (
      <div className="wstree-ws" key={ws}>
        <div
          className={`wstree-row ${isActiveWs ? 'wstree-row-active' : ''} ${isPreviewWs ? 'wstree-row-previewed' : ''}`}
        >
          <button
            type="button"
            className="wstree-caret"
            onClick={() => onToggleExpand(ws)}
            aria-label={isOpen ? 'colapsar' : 'expandir'}
          >
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <button
            type="button"
            className="wstree-name"
            title={ws}
            style={{ color: wsAccent }}
            onClick={() => onToggleExpand(ws)}
          >
            {nameOf(ws)}
          </button>
          <button
            type="button"
            className="wstree-x"
            title={t('ws.closeWorkspace')}
            onClick={(e) => {
              e.stopPropagation()
              onCloseWorkspace(ws)
            }}
          >
            <X size={12} />
          </button>
        </div>
        {isOpen && (
          <div className="wstree-children" style={{ ['--ws-tint' as string]: wsAccent }}>
            {sessions.map((s) => {
              const isActiveSession = isActiveWs && s.id === activeSessionId
              const isPreviewedSession =
                !!previewedSession && previewedSession.ws === ws && previewedSession.id === s.id
              // Show activity for ANY session (the live pool keeps cross-workspace sessions
              // running), so a session working in another workspace still pulses.
              const act = activity[s.id]
              return (
                <div
                  className={`wstree-session ${isActiveSession ? 'wstree-session-active' : ''} ${isPreviewedSession ? 'wstree-session-previewed' : ''}`}
                  key={s.id}
                >
                  <button
                    type="button"
                    className="wstree-session-btn"
                    title={s.label}
                    onClick={() => onSelectSession(ws, s.id)}
                  >
                    <span
                      className={`wstree-dot ${act?.active ? 'wstree-dot-on' : ''} ${act?.done ? 'wstree-dot-done' : ''}`}
                    />
                    <span className="wstree-session-name">{s.label}</span>
                  </button>
                  <button
                    type="button"
                    className="wstree-x"
                    title={t('ws.closeSession')}
                    onClick={(e) => {
                      e.stopPropagation()
                      // Fechar é sempre direto — nada se perde: o contexto da conversa fica em
                      // cardsByClaudeSession e reabre pelo picker "sessões anteriores".
                      onCloseSession(ws, s.id)
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            })}
            <button type="button" className="wstree-new" onClick={() => onNewSession(ws)}>
              <Plus size={12} />
              <span>{t('ws.newSession')}</span>
            </button>
            {isActiveWs && claudePrev.length > 0 && (
              <button
                type="button"
                className="wstree-new"
                title="conversas anteriores do claude neste workspace"
                onClick={() => setPrevOpenFor((prev) => ({ ...prev, [ws]: !prev[ws] }))}
              >
                <History size={12} />
                <span>sessões anteriores ({claudePrev.length})</span>
              </button>
            )}
            {isActiveWs && prevOpenFor[ws] && (
              <PrevClaudeSessions
                items={claudePrev}
                onLoad={onLoadClaudeSession}
                onDelete={onDeleteClaudeSession}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="wstree panel-focusable" data-panel="tree" data-focused={isFocused}>
      <div className="wstree-head">
        <span className="wstree-title">workspaces</span>
        <div className="wstree-filter" role="group" aria-label="filtrar abas por atividade">
          {(['all', '1d', '1h'] as WsActivityFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`wstree-filter-btn ${filter === f ? 'is-active' : ''}`}
              title={
                f === 'all'
                  ? 'todas as abas'
                  : f === '1d'
                    ? 'apenas abas ativas nas últimas 24h'
                    : 'apenas abas ativas na última hora'
              }
              onClick={() => onFilterChange(f)}
            >
              {f === 'all' ? 'tudo' : f}
            </button>
          ))}
        </div>
      </div>
      {workspaces.map((ws) => renderWorkspace(ws))}
      {filter !== 'all' && hiddenCount > 0 && (
        <button
          type="button"
          className="wstree-filter-more"
          title="mostrar todas as abas"
          onClick={() => onFilterChange('all')}
        >
          +{hiddenCount} aba{hiddenCount > 1 ? 's' : ''} oculta{hiddenCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  )
}

// Lista das conversas do claude (do workspace ativo) que não estão abertas. 1 clique = abre como
// aba e resume (`claude --resume <id>`). Reusa o visual do stash. Título = aiTitle (fallback id8).
function PrevClaudeSessions({
  items,
  onLoad,
  onDelete
}: {
  items: PrevClaudeSession[]
  onLoad: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <div className="wstree-stash">
      <div className="wstree-stash-list">
        {items.map((c) => (
          <div className="wstree-stash-row" key={c.id}>
            <button
              type="button"
              className="wstree-stash-btn"
              title={`resume ${c.id}`}
              onClick={(e) => {
                e.stopPropagation()
                onLoad(c.id)
              }}
            >
              <History size={10} className="wstree-stash-icon" />
              <span className="wstree-stash-name">
                {c.title || c.lastPrompt || c.id.slice(0, 8)}
              </span>
              <span className="wstree-stash-meta">
                {relativeTime(c.mtimeMs)}
                {c.gitBranch ? ` · ${c.gitBranch}` : ''}
              </span>
            </button>
            <button
              type="button"
              className="wstree-x"
              title="apagar conversa definitivamente"
              onClick={(e) => {
                e.stopPropagation()
                const label = c.title || c.lastPrompt || c.id.slice(0, 8)
                if (confirm(`Apagar definitivamente "${label}"?`)) {
                  onDelete(c.id)
                }
              }}
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

import Terminal from './Terminal'
import type { Session } from '../types'
import type { Mode, Theme } from '@decky/shared'
import { t } from '../lib/i18n'

interface TerminalHostProps {
  // The GLOBAL pool of live sessions (across workspaces). Every one mounts a terminal that
  // keeps running; only the active one is visible. Switching workspace doesn't unmount these,
  // so the session you leave isn't stopped.
  sessions: Session[]
  activeId?: string
  mode: Mode
  // Resolves a session's cwd to its workspace's theme (uses the persisted assignment table).
  themeFor: (path: string | null | undefined) => Theme
  // Comando default do workspace da cwd (defaultCmdByWs) — base do relançamento no resume. Ex.: um
  // wrapper que sobe o claude. null = sem default → cai no 'claude' puro.
  launchCmdFor?: (cwd: string) => string | null
  onUserInput: (id: string) => void
}

export default function TerminalHost({
  sessions,
  activeId,
  mode,
  themeFor,
  launchCmdFor,
  onUserInput
}: TerminalHostProps): React.JSX.Element {
  return (
    <div className="termhost">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        // `claudeSessionId` é sticky (capturado uma vez, não some quando o claude sai de foreground)
        // → é ELE, não o flag instantâneo `claude`, que decide o resume: se a aba já teve uma
        // conversa, relança nela com `--resume <id>`. Sem conversa, usa o `autorunCmd` (comando default
        // do workspace, ex 'claude --model x') e cai no `claude` limpo pro seed legado `claude:true`.
        // Terminal lê isto só no mount, flips em runtime não re-injetam.
        //
        // BASE DO RESUME: o comando default do workspace (defaultCmdByWs, via launchCmdFor) — ex. um
        // wrapper `~/bin/launch.sh` que faz `exec claude "$@"`. Appendamos `--resume <id>` à base e o
        // wrapper repassa pro claude. Sem default → 'claude' puro (idêntico ao comportamento anterior).
        // Não appendamos se a base já fixa a conversa (--resume/--continue/--from-pr/--session-id).
        const resumeBase = (launchCmdFor?.(s.cwd) ?? s.autorunCmd ?? 'claude').trim()
        const baseFixesSession =
          /(^|\s)(--resume|-r|--continue|-c|--from-pr|--session-id)(\s|$)/.test(resumeBase)
        const autorun = s.claudeSessionId
          ? baseFixesSession
            ? resumeBase
            : `${resumeBase} --resume ${s.claudeSessionId}`
          : (s.autorunCmd ?? (s.claude ? 'claude' : undefined))
        return (
          <div key={s.id} className={`termhost-body ${isActive ? 'termhost-body-active' : ''}`}>
            <Terminal
              id={s.id}
              cwd={s.cwd}
              autorun={autorun}
              claudeSessionId={s.claudeSessionId}
              visible={isActive}
              mode={mode}
              theme={themeFor(s.cwd)}
              onUserInput={() => onUserInput(s.id)}
            />
          </div>
        )
      })}
      {sessions.length === 0 && (
        <div className="panel-placeholder">
          <p className="muted">{t('term.noSessions')}</p>
        </div>
      )}
    </div>
  )
}

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
  onUserInput: (id: string) => void
}

export default function TerminalHost({
  sessions,
  activeId,
  mode,
  themeFor,
  onUserInput
}: TerminalHostProps): React.JSX.Element {
  return (
    <div className="termhost">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        // `claudeSessionId` é sticky (capturado uma vez, não some quando o claude sai de foreground)
        // → é ELE, não o flag instantâneo `claude`, que decide o resume: se a aba já teve uma
        // conversa, relança nela com `--resume <id>`. `claude` sem id (rodou mas não capturamos a
        // conversa) cai no `claude` limpo. Terminal lê isto só no mount, flips em runtime não re-injetam.
        const autorun = s.claudeSessionId
          ? `claude --resume ${s.claudeSessionId}`
          : s.claude
            ? 'claude'
            : undefined
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

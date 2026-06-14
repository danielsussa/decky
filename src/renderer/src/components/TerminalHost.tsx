import Terminal from './Terminal'
import type { Session } from '../types'
import type { Mode, Theme } from '../../../shared/themes'
import { CLI_SPECS } from '@decky/shared'
import { t } from '../lib/i18n'

interface TerminalHostProps {
  // The GLOBAL pool of live sessions (across workspaces). Every one mounts a terminal that
  // keeps running; only the active one is visible. Switching workspace doesn't unmount these,
  // so the session you leave isn't stopped.
  sessions: Session[]
  activeId?: string
  /** null = still fetching CLI list; [] = fetched, none installed. */
  detectionLoaded: boolean
  commandFor: (s: Session) => string[] | undefined
  mode: Mode
  // Resolves a session's cwd to its workspace's theme (uses the persisted assignment table).
  themeFor: (path: string | null | undefined) => Theme
  onUserInput: (id: string) => void
}

export default function TerminalHost({
  sessions,
  activeId,
  detectionLoaded,
  commandFor,
  mode,
  themeFor,
  onUserInput
}: TerminalHostProps): React.JSX.Element {
  return (
    <div className="termhost">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        const cmd = commandFor(s)
        const showPlaceholder = s.kind === 'claude' && !cmd
        const displayName = s.cliKind ? CLI_SPECS[s.cliKind].displayName : 'Claude Code'
        return (
          <div key={s.id} className={`termhost-body ${isActive ? 'termhost-body-active' : ''}`}>
            {showPlaceholder ? (
              <div className="panel-placeholder">
                <p className="muted">
                  {detectionLoaded
                    ? `${displayName}${t('term.notInstalledSuffix')}`
                    : `${t('term.resolvingPrefix')}${displayName.toLowerCase()}…`}
                </p>
              </div>
            ) : (
              <Terminal
                id={s.id}
                cwd={s.cwd}
                command={cmd}
                visible={isActive}
                mode={mode}
                theme={themeFor(s.cwd)}
                onUserInput={() => onUserInput(s.id)}
              />
            )}
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

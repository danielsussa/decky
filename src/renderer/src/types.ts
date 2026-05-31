import type { CliKind } from '../../shared/cli-spec'

export interface Session {
  id: string
  label: string
  project?: string
  cwd: string
  /** 'claude' here historically means "AI session" (any CLI). Which CLI is `cliKind`. */
  kind: 'claude' | 'shell'
  /** Which AI CLI to spawn for kind='claude'. Defaults to 'claude' on legacy sessions. */
  cliKind?: CliKind
  /** UUID passed to `claude --session-id` — persists conversation across restarts. Claude only. */
  claudeSessionId?: string
}

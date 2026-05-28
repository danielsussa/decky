export interface Session {
  id: string
  label: string
  project?: string
  cwd: string
  kind: 'claude' | 'shell'
  /** UUID passed to `claude --session-id` for kind=claude — persists conversation across restarts. */
  claudeSessionId?: string
}

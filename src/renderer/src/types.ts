export interface Session {
  id: string
  label: string
  project?: string
  cwd: string
  /** O claude era o foreground process do terminal no último save → relançar no próximo boot. */
  claude?: boolean
  /** Id da conversa do claude pra `claude --resume <id>` (cada terminal tem a sua). */
  claudeSessionId?: string
}

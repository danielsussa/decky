export interface Session {
  id: string
  label: string
  project?: string
  cwd: string
  /** O claude era o foreground process do terminal no último save → relançar no próximo boot. */
  claude?: boolean
  /** Id da conversa do claude pra `claude --resume <id>` (cada terminal tem a sua). */
  claudeSessionId?: string
  /**
   * Comando a dar autorun quando a aba monta (default do workspace, ex 'claude --model x'). Quando
   * ausente cai no shell puro. Tem precedência sobre o seed legado `claude`.
   */
  autorunCmd?: string
  /**
   * Última linha de lançamento do claude capturada nesta aba, já expandida (alias resolvido) e sem o
   * --session-id do shim. Só em memória (recapturada a cada run); alimenta o "definir como default".
   */
  launchCmd?: string
}

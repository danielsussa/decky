// Specs for AI CLIs the decky session picker can spawn. Pure: no Node-only APIs,
// safe to import from main and renderer.

export type CliKind = 'claude' | 'codex' | 'cline'

export interface CliSpec {
  kind: CliKind
  displayName: string
  bin: string
  /** Extra paths to try if `which <bin>` fails (homebrew, ~/.local/bin, etc.) */
  candidates: (homeDir: string) => string[]
  /** Shell command the user can paste to install this CLI. */
  installHint: string
  /** Whether this CLI supports resuming via a stable session id flag. */
  supportsResume: boolean
}

export const CLI_SPECS: Record<CliKind, CliSpec> = {
  claude: {
    kind: 'claude',
    displayName: 'Claude Code',
    bin: 'claude',
    candidates: (home) => [
      `${home}/.local/bin/claude`,
      `${home}/.claude/local/claude`,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ],
    installHint: 'npm i -g @anthropic-ai/claude-code',
    supportsResume: true
  },
  codex: {
    kind: 'codex',
    displayName: 'OpenAI Codex',
    bin: 'codex',
    candidates: (home) => [
      `${home}/.local/bin/codex`,
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex'
    ],
    installHint: 'npm i -g @openai/codex',
    supportsResume: false
  },
  cline: {
    kind: 'cline',
    displayName: 'Cline',
    bin: 'cline',
    candidates: (home) => [
      `${home}/.local/bin/cline`,
      '/opt/homebrew/bin/cline',
      '/usr/local/bin/cline'
    ],
    installHint: 'npm i -g cline',
    supportsResume: false
  }
}

export const CLI_KINDS: CliKind[] = Object.keys(CLI_SPECS) as CliKind[]

/** A CLI that has been resolved on the user's machine. */
export interface DetectedCli {
  kind: CliKind
  displayName: string
  bin: string
  version?: string
}

/** Install hint surfaced to the user when a CLI is missing. */
export interface CliInstallHint {
  kind: CliKind
  displayName: string
  installHint: string
}

export interface BuildArgsOpts {
  /** Stable id used by CLIs that support resume (currently only claude). */
  sessionId?: string
  /** System prompt to inject; only used by CLIs that accept one as a flag. */
  systemPrompt?: string
}

/**
 * Build the argv (excluding bin) for a fresh spawn of the given CLI.
 * Caller prepends the resolved bin path: `[bin, ...buildArgs(kind, opts)]`.
 */
export function buildArgs(kind: CliKind, opts: BuildArgsOpts = {}): string[] {
  switch (kind) {
    case 'claude': {
      const args: string[] = []
      if (opts.sessionId) args.push('--session-id', opts.sessionId)
      if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
      return args
    }
    case 'codex':
    case 'cline':
      // No resume / system-prompt flags wired up yet. Spawn fresh.
      return []
  }
}

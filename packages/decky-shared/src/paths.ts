import { homedir } from 'node:os'
import { join } from 'node:path'

// Global decky config (workspace registry, keymap, window prefs) lives here. Env-driven so a
// DECKY_DEV instance isolates onto ~/.deck-dev and never touches the stable app's config.
export function deckStateDir(): string {
  return process.env.DECKY_STATE_DIR || join(homedir(), '.decky')
}

// Per-workspace state + cards live INSIDE each workspace folder, so they travel with the
// project (git/clone) and vanish when it's deleted. A DECKY_DEV instance uses a separate dir
// name so it can share a folder with the stable app without clobbering it.
export function deckDirName(): string {
  return process.env.DECKY_DEV ? '.decky-dev' : '.decky'
}

export function workspaceDir(absPath: string): string {
  return join(absPath, deckDirName())
}

export function workspaceCardsDir(absPath: string): string {
  return join(workspaceDir(absPath), 'cards')
}

export function workspaceStatePath(absPath: string, file: string): string {
  return join(workspaceDir(absPath), file)
}

// A bot-supplied card id may carry "/" for subfolders; sanitize each segment but keep
// the structure.
export function safeCardId(cardId: string): string {
  return cardId
    .split('/')
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '-'))
    .filter(Boolean)
    .join('/')
}

export function cardFilePath(
  workspaceAbsPath: string,
  cardId: string,
  ext: '.md' | '.html' = '.md'
): string {
  return join(workspaceCardsDir(workspaceAbsPath), `${safeCardId(cardId)}${ext}`)
}

// True for card files decky generated (<workspace>/.decky[-dev]/cards/<id>.md) — their
// basenames are meaningless, so titles should derive from content, not the filename.
export function isGeneratedCardPath(p: string): boolean {
  return /\/\.decky(-dev)?\/cards\//.test(p)
}

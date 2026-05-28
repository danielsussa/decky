import { homedir } from 'node:os'
import { join } from 'node:path'

// Global deck config (workspace registry, keymap, window prefs) lives here. Env-driven so a
// DECK_DEV instance isolates onto ~/.deck-dev and never touches the stable app's config.
export function deckStateDir(): string {
  return process.env.DECK_STATE_DIR || join(homedir(), '.deck')
}

// Per-workspace state + cards live INSIDE each workspace folder, so they travel with the
// project (git/clone) and vanish when it's deleted. A DECK_DEV instance uses a separate dir
// name so it can share a folder with the stable app without clobbering it.
export function deckDirName(): string {
  return process.env.DECK_DEV ? '.deck-dev' : '.deck'
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

export function cardFilePath(workspaceAbsPath: string, cardId: string): string {
  return join(workspaceCardsDir(workspaceAbsPath), `${safeCardId(cardId)}.md`)
}

// True for card files deck generated (<workspace>/.deck[-dev]/cards/<id>.md) — their
// basenames are meaningless, so titles should derive from content, not the filename.
export function isGeneratedCardPath(p: string): boolean {
  return /\/\.deck(-dev)?\/cards\//.test(p)
}

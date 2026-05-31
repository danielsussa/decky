// Named actions + their key bindings, shared between renderer (matching) and
// the remap UI. Bindings are canonical accelerator strings ("Ctrl+ArrowUp",
// "Cmd+Alt+ArrowLeft"): modifiers in fixed order (Cmd, Ctrl, Alt, Shift) then
// the key. Every binding must include at least one modifier — the terminal
// owns bare keys.

export const isMac =
  typeof navigator !== 'undefined'
    ? /mac/i.test(navigator.platform || navigator.userAgent || '')
    : typeof process !== 'undefined' && process.platform === 'darwin'

// Primary modifier: Cmd on macOS (free — never reaches the terminal, no
// Mission Control clash), Ctrl elsewhere.
export const PRIMARY_MOD = isMac ? 'Cmd' : 'Ctrl'

export type ActionId =
  | 'session.prev'
  | 'session.next'
  | 'tab.prev'
  | 'tab.next'
  | 'tab.pin'

export interface ActionDef {
  id: ActionId
  label: string
  defaultAccel: string
}

export const ACTIONS: ActionDef[] = [
  { id: 'session.prev', label: 'Sessão anterior (acima)', defaultAccel: `${PRIMARY_MOD}+ArrowUp` },
  { id: 'session.next', label: 'Próxima sessão (abaixo)', defaultAccel: `${PRIMARY_MOD}+ArrowDown` },
  { id: 'tab.prev', label: 'Tab anterior (esquerda)', defaultAccel: `${PRIMARY_MOD}+ArrowLeft` },
  { id: 'tab.next', label: 'Próxima tab (direita)', defaultAccel: `${PRIMARY_MOD}+ArrowRight` },
  {
    id: 'tab.pin',
    label: 'Pinnar/despinnar tab focada',
    defaultAccel: isMac ? 'Cmd+Ctrl+P' : 'Ctrl+Alt+P'
  }
]

export type Keymap = Partial<Record<ActionId, string>>

export interface KeyEventLike {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
}

const MOD_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

function normalizeKey(k: string): string {
  return k.length === 1 ? k.toUpperCase() : k
}

/**
 * Canonical accelerator for a keyboard event, or null if it isn't a valid
 * binding (pressing only modifiers, or no modifier at all).
 */
export function eventToAccel(e: KeyEventLike): string | null {
  if (!e.key || MOD_KEYS.has(e.key)) return null
  const mods: string[] = []
  if (e.metaKey) mods.push('Cmd')
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (mods.length === 0) return null
  return [...mods, normalizeKey(e.key)].join('+')
}

export function matchesAccel(e: KeyEventLike, accel: string): boolean {
  const got = eventToAccel(e)
  return got !== null && got === accel
}

const SYMBOLS: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '⏎',
  Escape: 'Esc',
  ' ': 'Space'
}

export function accelLabel(accel: string): string {
  return accel
    .split('+')
    .map((p) => SYMBOLS[p] ?? p)
    .join(' ')
}

/** Fill in defaults for any action the stored keymap doesn't override. */
export function resolveKeymap(stored: Keymap | null | undefined): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>
  for (const a of ACTIONS) out[a.id] = stored?.[a.id] ?? a.defaultAccel
  return out
}

/** Returns the action id already bound to `accel`, ignoring `except`. */
export function conflictFor(
  resolved: Record<ActionId, string>,
  accel: string,
  except: ActionId
): ActionId | null {
  for (const a of ACTIONS) {
    if (a.id !== except && resolved[a.id] === accel) return a.id
  }
  return null
}

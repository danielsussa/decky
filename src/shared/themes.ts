// Two independent axes:
//  • COLOR (hue): each workspace gets one of 5 Natureza themes — each evoking a place, not just
//    a hue. The hash of its name picks a *preferred* theme; if that's already taken by another
//    workspace, the assigner falls back to the unused theme closest to the preferred hue (see
//    assignNewWorkspaceTheme). Up to 5 workspaces share no color; beyond that, collisions are
//    unavoidable and the preferred wins.
//  • MODE (dark/light): a global user preference, toggled from the command palette.
// Each theme carries a dark and a light surface; the workspace picks the hue, the mode picks the
// surface. The ANSI palette is fixed per-mode (not per-hue) so claude's terminal output reads the
// same across workspaces.

export type Mode = 'dark' | 'light'

type Vars = {
  '--bg-0': string
  '--bg-1': string
  '--bg-2': string
  '--border': string
  '--text-1': string
  '--text-2': string
  '--text-3': string
  '--accent': string
}

interface Surface {
  vars: Vars
  // Terminal selection highlight (not a CSS var, only used by xterm).
  selection: string
}

export interface Theme {
  id: string
  name: string
  dark: Surface
  light: Surface
}

export const THEMES: Theme[] = [
  {
    id: 'abissal',
    name: 'Abissal',
    dark: {
      vars: {
        '--bg-0': '#0a1929',
        '--bg-1': '#0f2336',
        '--bg-2': '#173249',
        '--border': '#122a3e',
        '--text-1': '#d6ecef',
        '--text-2': '#93b0b8',
        '--text-3': '#647c84',
        '--accent': '#5eead4'
      },
      selection: '#1f4658'
    },
    light: {
      vars: {
        '--bg-0': '#eaf6fb',
        '--bg-1': '#dceef5',
        '--bg-2': '#c2deeb',
        '--border': '#b8d4e2',
        '--text-1': '#0a1929',
        '--text-2': '#3d525e',
        '--text-3': '#6b828c',
        '--accent': '#0e7490'
      },
      selection: '#c1e2ef'
    }
  },
  {
    id: 'floresta',
    name: 'Floresta',
    dark: {
      vars: {
        '--bg-0': '#1a2419',
        '--bg-1': '#232f22',
        '--bg-2': '#324230',
        '--border': '#283626',
        '--text-1': '#dce8d6',
        '--text-2': '#9aac95',
        '--text-3': '#6e7d69',
        '--accent': '#86b069'
      },
      selection: '#3a5236'
    },
    light: {
      vars: {
        '--bg-0': '#f3f7ee',
        '--bg-1': '#e7eedb',
        '--bg-2': '#d5e1c4',
        '--border': '#c8d6b3',
        '--text-1': '#1a2419',
        '--text-2': '#4a5d44',
        '--text-3': '#7d8c77',
        '--accent': '#4a7c3a'
      },
      selection: '#d5e6bf'
    }
  },
  {
    id: 'cerrado',
    name: 'Cerrado',
    dark: {
      vars: {
        '--bg-0': '#241e15',
        '--bg-1': '#2f2719',
        '--bg-2': '#423724',
        '--border': '#362c1d',
        '--text-1': '#ece2d0',
        '--text-2': '#b09c82',
        '--text-3': '#7c6e58',
        '--accent': '#d9a441'
      },
      selection: '#553f1d'
    },
    light: {
      vars: {
        '--bg-0': '#fbf6ec',
        '--bg-1': '#f5ecd9',
        '--bg-2': '#ecdcb8',
        '--border': '#e0cfa6',
        '--text-1': '#241e15',
        '--text-2': '#5d4f38',
        '--text-3': '#8c7c5f',
        '--accent': '#8a5a18'
      },
      selection: '#ead6a5'
    }
  },
  {
    id: 'lava',
    name: 'Lava',
    dark: {
      vars: {
        '--bg-0': '#1a0e0a',
        '--bg-1': '#25140e',
        '--bg-2': '#3a2118',
        '--border': '#2c1813',
        '--text-1': '#ecd6cf',
        '--text-2': '#b09290',
        '--text-3': '#7c6660',
        '--accent': '#ff5a36'
      },
      selection: '#5a2418'
    },
    light: {
      vars: {
        '--bg-0': '#fff0ec',
        '--bg-1': '#fae0d6',
        '--bg-2': '#f5ccbb',
        '--border': '#efbeab',
        '--text-1': '#1a0e0a',
        '--text-2': '#5d3a30',
        '--text-3': '#8c6660',
        '--accent': '#b3361b'
      },
      selection: '#f5c7b5'
    }
  },
  {
    id: 'geleira',
    name: 'Geleira',
    dark: {
      vars: {
        '--bg-0': '#0e1a24',
        '--bg-1': '#15222e',
        '--bg-2': '#1f3243',
        '--border': '#182838',
        '--text-1': '#d6e3ec',
        '--text-2': '#95aab8',
        '--text-3': '#687a8a',
        '--accent': '#a5d8ff'
      },
      selection: '#25435c'
    },
    light: {
      vars: {
        '--bg-0': '#eef6fc',
        '--bg-1': '#e0eef8',
        '--bg-2': '#cee0ee',
        '--border': '#c2d5e3',
        '--text-1': '#0e1a24',
        '--text-2': '#3a525e',
        '--text-3': '#66828c',
        '--accent': '#1c6ea4'
      },
      selection: '#c8e0ef'
    }
  }
]


// Position on the color wheel (degrees), used only to break ties when the hashed-preferred
// theme is already taken: the assigner picks the unused theme whose hue is closest.
const THEME_HUE: Record<string, number> = {
  lava: 12,
  cerrado: 35,
  floresta: 130,
  abissal: 180,
  geleira: 200
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h
}

// Hash the workspace NAME (trailing folder, not the full path) → preferred theme index.
// Hashing the name spreads better than the full path, whose long shared prefix clumps
// everything onto a couple of colors.
function preferredThemeIdx(name: string): number {
  return djb2(name) % THEMES.length
}

// Greedy single-workspace assignment: pick the hashed-preferred theme if it's still free,
// otherwise the closest unused theme by hue. When all themes are taken (more workspaces than
// themes), collisions become unavoidable — the preferred wins. Caller passes the set of
// already-assigned theme IDs.
export function assignNewWorkspaceTheme(workspacePath: string, taken: Set<string>): Theme {
  const name = workspacePath.replace(/\/+$/, '').split('/').pop() || workspacePath
  const preferred = preferredThemeIdx(name)
  if (!taken.has(THEMES[preferred].id)) return THEMES[preferred]
  const prefHue = THEME_HUE[THEMES[preferred].id] ?? 0
  let best = preferred
  let bestDist = Infinity
  for (let i = 0; i < THEMES.length; i++) {
    if (taken.has(THEMES[i].id)) continue
    const d = hueDist(THEME_HUE[THEMES[i].id] ?? 0, prefHue)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return THEMES[best]
}

// Memoryless fallback: hash → theme, no collision avoidance. Used when no assignment exists
// yet (e.g. a session's cwd outside the registered workspace set, or pre-assignment renders).
export function themeForWorkspace(path: string | null | undefined): Theme {
  if (!path) return THEMES[0]
  const name = path.replace(/\/+$/, '').split('/').pop() || path
  return THEMES[preferredThemeIdx(name)]
}

// Resolve a path's theme via a persisted assignment table, falling back to the memoryless hash.
export function themeFromAssignments(
  path: string | null | undefined,
  assignments: Record<string, string>
): Theme {
  if (!path) return THEMES[0]
  const id = assignments[path]
  if (id) {
    const t = THEMES.find((th) => th.id === id)
    if (t) return t
  }
  return themeForWorkspace(path)
}

// ANSI 16-color palettes, fixed per mode. Tuned so claude's syntax/diff colors stay legible on
// the corresponding terminal background (dark set on dark bg, GitHub-light-ish set on light bg).
const ANSI_DARK = {
  black: '#1e2330',
  red: '#f48771',
  green: '#b5cea8',
  yellow: '#dcdcaa',
  blue: '#9cdcfe',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#6e6e6e',
  brightRed: '#f48771',
  brightGreen: '#b5cea8',
  brightYellow: '#dcdcaa',
  brightBlue: '#9cdcfe',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff'
}
const ANSI_LIGHT = {
  black: '#24292e',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#0f5323',
  brightYellow: '#7a4f01',
  brightBlue: '#043d8a',
  brightMagenta: '#6639ba',
  brightCyan: '#16636a',
  brightWhite: '#24292e'
}

// xterm theme: surface follows the workspace hue + mode, ANSI palette follows the mode only.
export function xtermTheme(t: Theme, mode: Mode): Record<string, string> {
  const s = t[mode]
  return {
    background: s.vars['--bg-0'],
    foreground: s.vars['--text-1'],
    cursor: s.vars['--accent'],
    cursorAccent: s.vars['--bg-0'],
    selectionBackground: s.selection,
    ...(mode === 'light' ? ANSI_LIGHT : ANSI_DARK)
  }
}

// Push a theme's CSS variables onto an element (default :root), overriding the stylesheet
// defaults. Sets data-theme/data-mode so CSS can hook the few hardcoded surfaces (e.g. JSON).
export function applyTheme(t: Theme, mode: Mode, el: HTMLElement = document.documentElement): void {
  const s = t[mode]
  for (const [k, v] of Object.entries(s.vars)) el.style.setProperty(k, v)
  el.dataset.theme = t.id
  el.dataset.mode = mode
}

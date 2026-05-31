// Two independent axes:
//  • COLOR (hue): each workspace gets one of 15 themes. The hash of its name picks a *preferred*
//    theme; if that's already taken by another workspace, the assigner falls back to the unused
//    theme closest to the preferred hue (see assignNewWorkspaceTheme). Up to 15 workspaces share
//    no color; beyond that, collisions are unavoidable and the preferred wins.
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
    id: 'rubi',
    name: 'Rubi',
    dark: {
      vars: {
        '--bg-0': '#261820',
        '--bg-1': '#321f29',
        '--bg-2': '#442b38',
        '--border': '#38232e',
        '--text-1': '#ecd6dd',
        '--text-2': '#b0939e',
        '--text-3': '#7c6670',
        '--accent': '#f06d6d'
      },
      selection: '#5a2d3e'
    },
    light: {
      vars: {
        '--bg-0': '#fdf3f5',
        '--bg-1': '#fbe9ed',
        '--bg-2': '#f6d9e0',
        '--border': '#f0cdd6',
        '--text-1': '#2e1820',
        '--text-2': '#5d4048',
        '--text-3': '#8c6670',
        '--accent': '#e11d48'
      },
      selection: '#f9d0da'
    }
  },
  {
    id: 'coral',
    name: 'Coral',
    dark: {
      vars: {
        '--bg-0': '#2a1c18',
        '--bg-1': '#36231f',
        '--bg-2': '#4a3028',
        '--border': '#3d2722',
        '--text-1': '#ecd8d2',
        '--text-2': '#b09690',
        '--text-3': '#7c6864',
        '--accent': '#ff7466'
      },
      selection: '#5a2d24'
    },
    light: {
      vars: {
        '--bg-0': '#fdf4f1',
        '--bg-1': '#fbe9e3',
        '--bg-2': '#f5d8cc',
        '--border': '#efccbf',
        '--text-1': '#2e1815',
        '--text-2': '#5d3a30',
        '--text-3': '#8c6660',
        '--accent': '#d94a2b'
      },
      selection: '#f9cfbf'
    }
  },
  {
    id: 'ambar',
    name: 'Âmbar',
    dark: {
      vars: {
        '--bg-0': '#241d14',
        '--bg-1': '#30271a',
        '--bg-2': '#423626',
        '--border': '#382e20',
        '--text-1': '#ece1d3',
        '--text-2': '#aa9a86',
        '--text-3': '#7c6e5c',
        '--accent': '#f0883e'
      },
      selection: '#5a4329'
    },
    light: {
      vars: {
        '--bg-0': '#fdf8f1',
        '--bg-1': '#f9efe1',
        '--bg-2': '#f1e2cc',
        '--border': '#ecd9bd',
        '--text-1': '#2e2516',
        '--text-2': '#5d4f38',
        '--text-3': '#8c7c60',
        '--accent': '#c2671c'
      },
      selection: '#f6e2bf'
    }
  },
  {
    id: 'sepia',
    name: 'Sépia',
    dark: {
      vars: {
        '--bg-0': '#221d18',
        '--bg-1': '#2c261f',
        '--bg-2': '#3d352c',
        '--border': '#322b24',
        '--text-1': '#e6dcd1',
        '--text-2': '#a89c8f',
        '--text-3': '#7a7065',
        '--accent': '#c8a978'
      },
      selection: '#4f4234'
    },
    light: {
      vars: {
        '--bg-0': '#faf6f0',
        '--bg-1': '#f1ebde',
        '--bg-2': '#e4d9c4',
        '--border': '#d8ccb3',
        '--text-1': '#2a241c',
        '--text-2': '#595044',
        '--text-3': '#8a8074',
        '--accent': '#7a5d3a'
      },
      selection: '#ead7b6'
    }
  },
  {
    id: 'ouro',
    name: 'Ouro',
    dark: {
      vars: {
        '--bg-0': '#251f10',
        '--bg-1': '#312a17',
        '--bg-2': '#443a21',
        '--border': '#38301b',
        '--text-1': '#ece4ce',
        '--text-2': '#b0a684',
        '--text-3': '#7c755a',
        '--accent': '#f1c54a'
      },
      selection: '#5a4920'
    },
    light: {
      vars: {
        '--bg-0': '#fdf9ec',
        '--bg-1': '#fbf2d5',
        '--bg-2': '#f3e3a6',
        '--border': '#ecd884',
        '--text-1': '#2e2710',
        '--text-2': '#5d5028',
        '--text-3': '#8c7c54',
        '--accent': '#a07900'
      },
      selection: '#f5e89e'
    }
  },
  {
    id: 'lima',
    name: 'Lima',
    dark: {
      vars: {
        '--bg-0': '#1d2412',
        '--bg-1': '#25311a',
        '--bg-2': '#354326',
        '--border': '#2b3920',
        '--text-1': '#dde6cf',
        '--text-2': '#9eaa86',
        '--text-3': '#717c5a',
        '--accent': '#a3df4f'
      },
      selection: '#3f5526'
    },
    light: {
      vars: {
        '--bg-0': '#f7faed',
        '--bg-1': '#eef4d8',
        '--bg-2': '#dfeab2',
        '--border': '#d2e09a',
        '--text-1': '#232e10',
        '--text-2': '#4f5d28',
        '--text-3': '#7d8c54',
        '--accent': '#5a8b00'
      },
      selection: '#e6f0b3'
    }
  },
  {
    id: 'verde',
    name: 'Verde',
    dark: {
      vars: {
        '--bg-0': '#16241c',
        '--bg-1': '#1d2f24',
        '--bg-2': '#2a4032',
        '--border': '#26382c',
        '--text-1': '#d6e6da',
        '--text-2': '#93a899',
        '--text-3': '#677c6e',
        '--accent': '#3fb950'
      },
      selection: '#2d5a3a'
    },
    light: {
      vars: {
        '--bg-0': '#f2faf4',
        '--bg-1': '#e7f4ea',
        '--bg-2': '#d8ebdd',
        '--border': '#cfe5d4',
        '--text-1': '#1f2e23',
        '--text-2': '#4b5d50',
        '--text-3': '#7b8c80',
        '--accent': '#1f9d3a'
      },
      selection: '#cdeed5'
    }
  },
  {
    id: 'jade',
    name: 'Jade',
    dark: {
      vars: {
        '--bg-0': '#142420',
        '--bg-1': '#1a302a',
        '--bg-2': '#26423b',
        '--border': '#203830',
        '--text-1': '#d3e8df',
        '--text-2': '#8fb0a3',
        '--text-3': '#647c72',
        '--accent': '#34d399'
      },
      selection: '#2a5446'
    },
    light: {
      vars: {
        '--bg-0': '#f1faf6',
        '--bg-1': '#e1f4eb',
        '--bg-2': '#cee8da',
        '--border': '#c1e0cd',
        '--text-1': '#16302a',
        '--text-2': '#3d5d52',
        '--text-3': '#6c8c80',
        '--accent': '#047857'
      },
      selection: '#c5edda'
    }
  },
  {
    id: 'ciano',
    name: 'Ciano',
    dark: {
      vars: {
        '--bg-0': '#142424',
        '--bg-1': '#1a3030',
        '--bg-2': '#264242',
        '--border': '#203838',
        '--text-1': '#d3e8e6',
        '--text-2': '#8fb0ac',
        '--text-3': '#647c7a',
        '--accent': '#2dd4bf'
      },
      selection: '#2d5a56'
    },
    light: {
      vars: {
        '--bg-0': '#f1faf9',
        '--bg-1': '#e4f4f2',
        '--bg-2': '#d3ebe8',
        '--border': '#c8e5e1',
        '--text-1': '#16302e',
        '--text-2': '#3d5d59',
        '--text-3': '#6c8c88',
        '--accent': '#0d9488'
      },
      selection: '#c6efe9'
    }
  },
  {
    id: 'turquesa',
    name: 'Turquesa',
    dark: {
      vars: {
        '--bg-0': '#14232a',
        '--bg-1': '#1a2e37',
        '--bg-2': '#263f4a',
        '--border': '#20353f',
        '--text-1': '#d3e2ea',
        '--text-2': '#8fa6b3',
        '--text-3': '#64768a',
        '--accent': '#38bdf8'
      },
      selection: '#2a4a5e'
    },
    light: {
      vars: {
        '--bg-0': '#f0f9fc',
        '--bg-1': '#e0f1f8',
        '--bg-2': '#ccdfeb',
        '--border': '#bfd6e4',
        '--text-1': '#14242e',
        '--text-2': '#3a525e',
        '--text-3': '#66828c',
        '--accent': '#0e7490'
      },
      selection: '#c4e0ed'
    }
  },
  {
    id: 'azul',
    name: 'Azul',
    dark: {
      vars: {
        '--bg-0': '#16202e',
        '--bg-1': '#1d2a3b',
        '--bg-2': '#2a3a4f',
        '--border': '#263545',
        '--text-1': '#d3e0ee',
        '--text-2': '#92a2b6',
        '--text-3': '#66768a',
        '--accent': '#4aa3ff'
      },
      selection: '#2d4a6e'
    },
    light: {
      vars: {
        '--bg-0': '#f2f7fd',
        '--bg-1': '#e8f0fb',
        '--bg-2': '#dbe8f7',
        '--border': '#d2e0f0',
        '--text-1': '#1f2937',
        '--text-2': '#4b5563',
        '--text-3': '#7b8694',
        '--accent': '#2563eb'
      },
      selection: '#cfe0fb'
    }
  },
  {
    id: 'grafite',
    name: 'Grafite',
    dark: {
      vars: {
        '--bg-0': '#1c1f24',
        '--bg-1': '#262a31',
        '--bg-2': '#353a44',
        '--border': '#2e333b',
        '--text-1': '#d9dee6',
        '--text-2': '#99a1ad',
        '--text-3': '#6c7480',
        '--accent': '#aab4c4'
      },
      selection: '#3a414e'
    },
    light: {
      vars: {
        '--bg-0': '#f6f7f9',
        '--bg-1': '#eef0f3',
        '--bg-2': '#e1e5ea',
        '--border': '#d6dbe2',
        '--text-1': '#1f242c',
        '--text-2': '#4b515c',
        '--text-3': '#7b8290',
        '--accent': '#4f5b6b'
      },
      selection: '#dde2e9'
    }
  },
  {
    id: 'indigo',
    name: 'Índigo',
    dark: {
      vars: {
        '--bg-0': '#1b1d34',
        '--bg-1': '#232542',
        '--bg-2': '#303359',
        '--border': '#292c4e',
        '--text-1': '#d4d6ee',
        '--text-2': '#9498ba',
        '--text-3': '#686c8e',
        '--accent': '#818cf8'
      },
      selection: '#3a3f7a'
    },
    light: {
      vars: {
        '--bg-0': '#f4f4fd',
        '--bg-1': '#e9eafb',
        '--bg-2': '#d8dcf6',
        '--border': '#cdd0ee',
        '--text-1': '#1f2040',
        '--text-2': '#4f5273',
        '--text-3': '#7d80a0',
        '--accent': '#4338ca'
      },
      selection: '#d6daf5'
    }
  },
  {
    id: 'violeta',
    name: 'Violeta',
    dark: {
      vars: {
        '--bg-0': '#1e2330',
        '--bg-1': '#262c3b',
        '--bg-2': '#353c4f',
        '--border': '#2e3447',
        '--text-1': '#d7dee9',
        '--text-2': '#95a0b3',
        '--text-3': '#6a7385',
        '--accent': '#8a5cf6'
      },
      selection: '#3b4a6e'
    },
    light: {
      vars: {
        '--bg-0': '#f6f4fd',
        '--bg-1': '#efeafb',
        '--bg-2': '#e4dcf6',
        '--border': '#ddd4f0',
        '--text-1': '#2a2440',
        '--text-2': '#5b5570',
        '--text-3': '#8b85a0',
        '--accent': '#7c3aed'
      },
      selection: '#ddd0fa'
    }
  },
  {
    id: 'magenta',
    name: 'Magenta',
    dark: {
      vars: {
        '--bg-0': '#261626',
        '--bg-1': '#321d32',
        '--bg-2': '#442944',
        '--border': '#382238',
        '--text-1': '#ecd6e9',
        '--text-2': '#b0939d',
        '--text-3': '#7c666f',
        '--accent': '#ec4899'
      },
      selection: '#5a2b50'
    },
    light: {
      vars: {
        '--bg-0': '#fdf2f8',
        '--bg-1': '#fbe6f0',
        '--bg-2': '#f6cfe2',
        '--border': '#f0c0d6',
        '--text-1': '#2e1626',
        '--text-2': '#5d384e',
        '--text-3': '#8c6079',
        '--accent': '#be185d'
      },
      selection: '#f6c8de'
    }
  }
]

// Position on the color wheel (degrees), used only to break ties when the hashed-preferred
// theme is already taken: the assigner picks the unused theme whose hue is closest. Sépia and
// Grafite are neutrals — placed near amber and blue respectively so they're chosen as fallback
// for warm/cool collisions rather than randomly.
const THEME_HUE: Record<string, number> = {
  rubi: 0,
  coral: 12,
  ambar: 25,
  sepia: 30,
  ouro: 45,
  lima: 85,
  verde: 130,
  jade: 155,
  ciano: 170,
  turquesa: 190,
  azul: 210,
  grafite: 220,
  indigo: 245,
  violeta: 265,
  magenta: 310
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
// Hashing the name spreads better across the 15 themes than the full path, whose long shared
// prefix clumps everything onto a couple of colors.
function preferredThemeIdx(name: string): number {
  return djb2(name) % THEMES.length
}

// Greedy single-workspace assignment: pick the hashed-preferred theme if it's still free,
// otherwise the closest unused theme by hue. When all 15 are taken (>15 workspaces), collisions
// become unavoidable — the preferred wins. Caller passes the set of already-assigned theme IDs.
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

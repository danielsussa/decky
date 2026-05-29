// 7 dark color themes. The theme is NOT user-selectable — it's derived deterministically from
// the workspace path (hash → one of 7), so each workspace gets a stable color identity and you
// can tell WS A from WS B at a glance. Only bg/fg/accent shift; the ANSI palette stays fixed so
// claude's terminal output reads the same everywhere.

export interface Theme {
  id: string
  name: string
  vars: {
    '--bg-0': string
    '--bg-1': string
    '--bg-2': string
    '--border': string
    '--text-1': string
    '--text-2': string
    '--text-3': string
    '--accent': string
  }
  // Terminal selection highlight (not exposed as a CSS var, only used by xterm).
  selection: string
}

export const THEMES: Theme[] = [
  {
    id: 'violeta',
    name: 'Violeta',
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
  {
    id: 'azul',
    name: 'Azul',
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
  {
    id: 'verde',
    name: 'Verde',
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
  {
    id: 'ambar',
    name: 'Âmbar',
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
  {
    id: 'rubi',
    name: 'Rubi',
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
  {
    id: 'ciano',
    name: 'Ciano',
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
  {
    id: 'grafite',
    name: 'Grafite',
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
  }
]

// Stable ANSI 16-color palette, shared by every theme. Tinting these per-theme would distort
// claude's syntax/diff colors, so only the surface (bg/fg/cursor/selection) changes.
const ANSI = {
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

// Hash the workspace NAME (trailing folder, not the full path) → stable index into THEMES.
// Hashing the name spreads better across the 7 themes than the full path, whose long shared
// prefix (~/Documents/projects/…) clumps everything onto a couple of colors. Same name always
// lands on the same theme, so a workspace keeps its color identity across restarts.
export function themeForWorkspace(path: string | null | undefined): Theme {
  if (!path) return THEMES[0]
  const name = path.replace(/\/+$/, '').split('/').pop() || path
  let h = 5381
  for (let i = 0; i < name.length; i++) h = (((h << 5) + h) ^ name.charCodeAt(i)) >>> 0
  return THEMES[h % THEMES.length]
}

// xterm theme: surface follows the workspace theme, ANSI palette stays fixed.
export function xtermTheme(t: Theme): Record<string, string> {
  return {
    background: t.vars['--bg-0'],
    foreground: t.vars['--text-1'],
    cursor: t.vars['--accent'],
    cursorAccent: t.vars['--bg-0'],
    selectionBackground: t.selection,
    ...ANSI
  }
}

// Push a theme's CSS variables onto an element (default :root), overriding the stylesheet defaults.
export function applyTheme(t: Theme, el: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(t.vars)) el.style.setProperty(k, v)
  el.dataset.theme = t.id
}

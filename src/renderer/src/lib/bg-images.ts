// Resolve uma URL bundlada (Vite hash) pra background do tema. As PNGs vivem em
// src/renderer/src/assets/bg/<themeId>/<idx>.png; o glob eager pega tudo no build e
// expõe um map <abs key, url>. Pickamos pelo seed (hash djb2 do workspace path) pra
// cada workspace ter uma das imagens disponíveis estável entre reloads.

const URLS = import.meta.glob('../assets/bg/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

// Agrupa por themeId. Chave do glob é '../assets/bg/<theme>/<n>.png' (relativa a este file).
const BY_THEME: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {}
  for (const [key, url] of Object.entries(URLS)) {
    const m = key.match(/\/bg\/([^/]+)\/(\d+)\.png$/)
    if (!m) continue
    const [, theme, idxStr] = m
    const idx = Number(idxStr)
    out[theme] ??= []
    out[theme][idx] = url
  }
  // Filtra slots vazios (caso a numeração tenha buracos).
  for (const t of Object.keys(out)) out[t] = out[t].filter(Boolean)
  return out
})()

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h
}

export function bgUrlFor(themeId: string, seed?: string | null): string | null {
  const urls = BY_THEME[themeId]
  if (!urls || urls.length === 0) return null
  const idx = seed ? djb2(seed) % urls.length : 0
  return urls[idx]
}

// URL exata de uma imagem fixada (tema + índice), pro background pinado pelo usuário no
// seletor de Tema. null se o slot não existe.
export function bgUrlAt(themeId: string, idx: number): string | null {
  return BY_THEME[themeId]?.[idx] ?? null
}

// Todas as imagens de um tema (ordenadas por índice), pro grid do seletor de Tema.
export function bgImagesFor(themeId: string): string[] {
  return BY_THEME[themeId] ?? []
}

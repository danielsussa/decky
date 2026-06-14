export type Locale = 'pt' | 'en'

export const DEFAULT_LOCALE: Locale = 'en'

// "pt-BR" / "pt-PT" → "pt", "en-US" → "en", anything else → DEFAULT_LOCALE.
export function normalizeLocale(raw: string | undefined | null): Locale {
  if (!raw) return DEFAULT_LOCALE
  const head = raw.toLowerCase().split(/[-_]/, 1)[0]
  return head === 'pt' || head === 'en' ? head : DEFAULT_LOCALE
}

export const LOCALE_ARG_PREFIX = '--decky-locale='

// URL do WS server passada do main pro preload via webPreferences.additionalArguments. Mesma
// convenção do locale: string em process.argv lida no boot (preload roda antes do renderer e
// não tem IPC síncrono pra perguntar a URL).
export const WS_URL_PREFIX = '--decky-ws-url='

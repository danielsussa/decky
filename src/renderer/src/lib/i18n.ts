import type { Locale } from '../../../shared/locale'

// Tiny string dictionary, no runtime deps. Keys are flat dotted ids; values are
// language → string. Migrations land here one key at a time — no big-bang rewrite.
const messages = {
  'rebuild.running': { pt: 'Rebuilding…', en: 'Rebuilding…' },
  'rebuild.readyPrefix': { pt: '↻ Build pronto em ', en: '↻ Build ready in ' },
  'rebuild.readySuffix': { pt: ' — clique pra relaunch', en: ' — click to relaunch' },
  'rebuild.errorPrefix': { pt: 'Rebuild falhou em ', en: 'Rebuild failed in ' },
  'rebuild.errorSuffix': { pt: ' — clique pra tentar de novo', en: ' — click to retry' },
  'rebuild.readyTooltip': { pt: 'Clique pra relaunch', en: 'Click to relaunch' },
  'rebuild.errorTooltip': { pt: 'Clique pra tentar de novo', en: 'Click to retry' }
} as const satisfies Record<string, Record<Locale, string>>

export type MessageKey = keyof typeof messages

const locale: Locale = window.deck?.app?.locale ?? 'en'

export function t(key: MessageKey): string {
  return messages[key][locale]
}

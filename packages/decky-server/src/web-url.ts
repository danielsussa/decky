// address-bar → URL canônica. Mesmo afordance do normalizeAddress dos outros hosts:
//  - já tem scheme suportado → mantém
//  - localhost / 127.0.0.1 → assume http://
//  - tem ponto e nada de espaço → assume https:// (domain.tld)
//  - resto → vira busca no Google
export function normalizeAddressBarUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return 'about:blank'
  if (/^(https?|file|about|data|chrome):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

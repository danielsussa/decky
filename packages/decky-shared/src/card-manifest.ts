// Card-manifesto: a fonte da verdade de um card no modelo "1 card = N widgets".
// Um card-manifesto é um <id>.json em .decky/cards/; o servidor o renderiza pra HTML on-the-fly
// (renderManifest, em @decky/server/card-render). Cada widget vira o mesmo bloco
// `<div data-decky-<type>>{spec}</div>` que o runtime vanilla já lê hoje — então os módulos de
// widget montam sem alteração; só a fonte (o JSON) é nova. Cards .html freeform seguem coexistindo
// (kind 'html' implícito): o manifesto é um caminho novo, não uma migração forçada.

// Tipos de widget conhecidos pelo runtime. Adicionar um widget novo = incluir o nome aqui (+ o
// módulo JS em card-render.ts). Esta é a ÚNICA lista — tanto a injeção de scripts do preview_html
// (renderer) quanto o renderManifest (servidor) leem daqui, pra não divergirem.
export const KNOWN_WIDGET_TYPES = [
  'title',
  'text',
  'toc',
  'flow',
  'checklist',
  'matrix',
  'roadmap',
  'mermaid'
] as const
export type WidgetType = (typeof KNOWN_WIDGET_TYPES)[number]

// Um widget dentro do manifesto. `spec` é o JSON específico do widget (a mesma forma que o
// runtime vanilla lê do div data-decky-<type> hoje); `id` o endereça pra ops/getters via bridge.
export type CardWidget = {
  id: string
  type: string
  spec?: Record<string, unknown>
}

// O manifesto de um card. Persistido como <id>.json. `kind: 'manifest'` é o discriminador que
// distingue um card-manifesto de qualquer outro .json no diretório de cards.
export type CardManifest = {
  v: 1
  kind: 'manifest'
  title?: string
  widgets: CardWidget[]
}

// Guard: o valor parseado de um .json é um card-manifesto? (kind marcado + widgets array).
export function isCardManifest(value: unknown): value is CardManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return m.kind === 'manifest' && Array.isArray(m.widgets)
}

// Manifesto vazio — o que `new-tab` cria (a tab "sem type específico"); ganha widgets via push.
export function emptyManifest(title?: string): CardManifest {
  return { v: 1, kind: 'manifest', title, widgets: [] }
}

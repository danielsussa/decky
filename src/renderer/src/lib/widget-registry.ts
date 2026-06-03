// Live widget registry — a mounted React widget inside a card can register itself here so
// the AI (via MCP `card_invoke` / `card_get`) can call its operations or read its state
// imperatively, WITHOUT going through the markdown file. The card is still the document;
// the widget owns its state; this registry is just the I/O surface that the bridge in main
// uses to dispatch calls.
//
// Two registries:
//   - widgetTypes: static, populated at module load (one entry per widget KIND). Self-documents
//     ops + getters so MCP `list_widgets` can return the catalog without hardcoding.
//   - widgets: dynamic, populated per-instance at mount. Keyed by (cardId, widgetId).

export type WidgetOp = (args: unknown) => unknown | Promise<unknown>
export type WidgetGetter = () => unknown

export interface Widget {
  type: string
  ops?: Record<string, WidgetOp>
  getters?: Record<string, WidgetGetter>
}

// JSON-schema-ish shape for op args — keeps it human-readable when echoed via MCP.
export interface WidgetOpDoc {
  name: string
  description: string
  args?: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; default?: unknown }>
    required?: string[]
  }
}

export interface WidgetGetterDoc {
  name: string
  description: string
}

export interface WidgetTypeDoc {
  type: string
  fence: string // e.g. "```flow" — the fenced-block opener used in markdown
  description: string
  specSchema?: string // hint at the JSON spec body (free-form prose)
  ops: WidgetOpDoc[]
  getters: WidgetGetterDoc[]
}

const widgetTypes = new Map<string, WidgetTypeDoc>()
const widgets = new Map<string, Widget>()

function key(cardId: string, widgetId: string): string {
  return `${cardId} ${widgetId}`
}

// Called at MODULE LOAD by each widget kind (FlowBlock, ChecklistBlock, ...). Idempotent so
// hot-reload during dev doesn't blow up.
export function registerWidgetType(doc: WidgetTypeDoc): void {
  widgetTypes.set(doc.type, doc)
}

export function listWidgetTypes(): WidgetTypeDoc[] {
  return [...widgetTypes.values()]
}

export function registerWidget(cardId: string, widgetId: string, widget: Widget): () => void {
  const k = key(cardId, widgetId)
  widgets.set(k, widget)
  return () => {
    if (widgets.get(k) === widget) widgets.delete(k)
  }
}

export async function invokeWidget(
  cardId: string,
  widgetId: string,
  op: string,
  args: unknown
): Promise<unknown> {
  const w = widgets.get(key(cardId, widgetId))
  if (!w) throw new Error(`widget not found: ${cardId}/${widgetId}`)
  const fn = w.ops?.[op]
  if (!fn) throw new Error(`widget ${cardId}/${widgetId} has no op '${op}'`)
  return await fn(args)
}

export function getWidget(cardId: string, widgetId: string, getterKey: string): unknown {
  const w = widgets.get(key(cardId, widgetId))
  if (!w) throw new Error(`widget not found: ${cardId}/${widgetId}`)
  const fn = w.getters?.[getterKey]
  if (!fn) throw new Error(`widget ${cardId}/${widgetId} has no getter '${getterKey}'`)
  return fn()
}

export interface ActiveWidget {
  cardId: string
  widgetId: string
  type: string
}

export function listActiveWidgets(): ActiveWidget[] {
  const out: ActiveWidget[] = []
  for (const [k, w] of widgets.entries()) {
    const sep = k.indexOf(' ')
    out.push({
      cardId: sep === -1 ? k : k.slice(0, sep),
      widgetId: sep === -1 ? '' : k.slice(sep + 1),
      type: w.type
    })
  }
  return out
}

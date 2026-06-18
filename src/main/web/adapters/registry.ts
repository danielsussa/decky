// Adapter registry — the "high-level API" of the browser layer (ported from handoff
// adapters/registry.ts). Each adapter declares semantic verbs (tools) + a URL match; given the
// active card's URL, the matching adapters' tools are surfaced so the browser is "self-describing
// per site". A tool's run() composes the facilitators via a WebContext bound to the card.
//
// CONTRACT ONLY for now: ADAPTERS is empty. Migrate site plugins (whatsapp, dell, …) on demand by
// pushing Adapter objects here — the wiring (list/run endpoints + `decky web adapter…`) is ready.

import type { WebContents } from 'electron'
import {
  clickJs,
  clickLabel,
  READ_JS,
  settle,
  SNAPSHOT_JS,
  typeJs,
  waitRequest,
  waitUntil,
  type ClickLabelOpts,
  type WaitRequestOpts,
  type WaitUntilOpts
} from '../facilitators'
import { getSecret } from '../secrets'

// The decky facilitators bound to one web card — handed to an adapter tool's run(). This is the
// adapter-facing SDK: an adapter composes these instead of touching the WebContents directly.
export interface WebContext {
  wc: WebContents
  navigate(url: string): Promise<void>
  snapshot(): Promise<unknown>
  read(): Promise<unknown>
  click(ref: string): Promise<unknown>
  clickLabel(pattern: string, opts?: ClickLabelOpts): Promise<{ label: string; ref: string }>
  type(ref: string, text: string): Promise<unknown>
  eval(code: string): Promise<unknown>
  settle(): Promise<unknown>
  waitUntil(expression: string, opts?: WaitUntilOpts): Promise<unknown>
  waitRequest(pattern: string, opts?: WaitRequestOpts): Promise<unknown>
  secret(name: string): Promise<string | null>
}

export interface AdapterTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (ctx: WebContext, args: Record<string, unknown>) => Promise<unknown>
}

export interface Adapter {
  id: string
  match: (url: string) => boolean
  tools: AdapterTool[]
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function makeWebContext(wc: WebContents): WebContext {
  return {
    wc,
    navigate: async (url) => {
      await wc.loadURL(url).catch(() => {})
      await settle(wc)
    },
    snapshot: () => wc.executeJavaScript(SNAPSHOT_JS),
    read: () => wc.executeJavaScript(READ_JS),
    click: (ref) => wc.executeJavaScript(clickJs(ref), true),
    clickLabel: (pattern, opts) => clickLabel(wc, pattern, opts),
    type: (ref, text) => wc.executeJavaScript(typeJs(ref, text), true),
    eval: (code) => wc.executeJavaScript(code),
    settle: () => settle(wc),
    waitUntil: (expression, opts) => waitUntil(wc, expression, opts),
    waitRequest: (pattern, opts) => waitRequest(wc, pattern, opts),
    secret: (name) => getSecret(name)
  }
}

// No site plugins migrated yet. Add Adapter objects here to make their verbs appear for matching URLs.
export const ADAPTERS: Adapter[] = []

export function adaptersForUrl(url: string): Adapter[] {
  return ADAPTERS.filter((a) => {
    try {
      return a.match(url)
    } catch {
      return false
    }
  })
}

export interface AdapterToolInfo {
  adapter: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// The verbs surfaced for the active card's URL — what the agent "sees" on that site. The run fn is
// stripped (not serializable); callers execute via findAdapterTool + runAdapterTool.
export function adapterToolsForUrl(url: string): AdapterToolInfo[] {
  return adaptersForUrl(url).flatMap((a) =>
    a.tools.map((t) => ({
      adapter: a.id,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  )
}

export function findAdapterTool(name: string): AdapterTool | undefined {
  for (const a of ADAPTERS) {
    const t = a.tools.find((x) => x.name === name)
    if (t) return t
  }
  return undefined
}

// hostOf is exported for adapters that need it in their match fn without re-implementing it.
export { hostOf }

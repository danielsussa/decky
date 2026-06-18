// Replay log for web cards — a JSONL trail of state-changing actions per card, ported from handoff
// sdk/replay.ts. Each event records the action, sanitized args (passwords/long strings redacted),
// duration, ok/error, and url before/after. Stored under <userData>/web-replay/<cardId>/events.jsonl.
// Surfaced by `decky web replay` (GET /web/replay).

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_CHANGING = new Set(['navigate', 'resilient-navigate', 'click', 'type', 'click-label'])

export function isStateChanging(action: string): boolean {
  return STATE_CHANGING.has(action)
}

export interface ReplayEvent {
  id: number
  ts: number
  cmd: string
  args: Record<string, unknown>
  durationMs: number
  ok: boolean
  error?: string
  urlBefore?: string
  urlAfter?: string
}

function replayDir(): string {
  return join(app.getPath('userData'), 'web-replay')
}

function cardDir(cardId: string): string {
  const safe = cardId.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(replayDir(), safe)
}

let seq = Date.now()
export function nextEventId(): number {
  return ++seq
}

export function record(cardId: string, event: ReplayEvent): void {
  try {
    const dir = cardDir(cardId)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n')
  } catch {
    // best-effort — never break a web action over replay logging
  }
}

export function readEvents(
  cardId: string,
  opts: { last?: number; since?: number } = {}
): ReplayEvent[] {
  const file = join(cardDir(cardId), 'events.jsonl')
  if (!existsSync(file)) return []
  let events: ReplayEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      events.push(JSON.parse(line) as ReplayEvent)
    } catch {
      // skip malformed lines
    }
  }
  if (opts.since !== undefined) events = events.filter((e) => e.ts >= opts.since!)
  if (opts.last !== undefined && events.length > opts.last) events = events.slice(-opts.last)
  return events
}

const TRUNCATE = 500

// Compact, safe representation of a /web/act body for storage: drop routing keys, redact typed
// text, truncate long strings.
export function sanitizeArgs(
  action: string,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'action' || k === 'cardId') continue
    if (action === 'type' && k === 'text') {
      out[k] = '***'
      continue
    }
    if (typeof v === 'string' && v.length > TRUNCATE) {
      out[k] = v.slice(0, TRUNCATE) + `… [+${v.length - TRUNCATE} chars]`
      continue
    }
    if (v !== undefined) out[k] = v
  }
  return out
}

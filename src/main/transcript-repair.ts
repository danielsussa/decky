import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'os'

// claude stores each session at ~/.claude/projects/<cwd-with-slashes-as-dashes>/<uuid>.jsonl
function transcriptPath(cwd: string, uuid: string): string {
  const encoded = cwd.replace(/\//g, '-')
  return join(os.homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`)
}

interface Block {
  type?: string
}
interface JsonlEntry {
  uuid?: string
  parentUuid?: string | null
  type?: string
  message?: { role?: string; id?: string; content?: unknown }
}

const isThinking = (b: Block): boolean => b.type === 'thinking' || b.type === 'redacted_thinking'

function blocks(o: JsonlEntry | null): Block[] {
  const c = o?.message?.content
  return Array.isArray(c) ? (c as Block[]) : []
}

/**
 * Heal a claude session transcript so it can be resumed without the API rejecting
 * its thinking blocks ("`thinking` ... blocks cannot be modified, must remain as in
 * the original response").
 *
 * The wedge: when claude is interrupted mid-thinking (e.g. the user edits/sends a new
 * message while a turn is still streaming), the thinking block from that turn stays in
 * the transcript. On every later request the CLI re-derives the request from the
 * transcript and the block ends up modified relative to what the model originally
 * produced — the API rejects it and the whole thread is frozen. This is a known
 * claude-code bug (anthropics/claude-code #12311, #13012, ...).
 *
 * The fix uses the API's own rule (docs: "extended thinking"): thinking blocks are only
 * REQUIRED on an assistant turn whose continuation is a `tool_result`; once a plain user
 * message follows, prior thinking blocks may be omitted. So we strip the *entire*
 * consecutive thinking sequence (omitting is allowed; modifying/partial-removal is not)
 * from every assistant turn that is NOT answered by a tool_result, and keep thinking on
 * live tool-use loops. Stripping removes the poisoned block; resume then succeeds.
 *
 * Entries emptied by stripping are dropped and the parentUuid chain is relinked.
 * Returns the number of entries changed (0 = nothing to do, no write).
 */
export function sanitizeTranscript(cwd: string, uuid: string): number {
  const path = transcriptPath(cwd, uuid)
  if (!existsSync(path)) return 0

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return 0
  }

  const parsed = raw.split('\n').map((line) => {
    const s = line.trim()
    if (!s) return { obj: null as JsonlEntry | null, line }
    try {
      return { obj: JSON.parse(s) as JsonlEntry, line }
    } catch {
      return { obj: null as JsonlEntry | null, line }
    }
  })

  const isUserWithToolResult = (o: JsonlEntry): boolean =>
    o.type === 'user' && blocks(o).some((b) => b.type === 'tool_result')

  // An assistant turn = consecutive entries sharing one message.id ([thinking],
  // [tool_use], ...). Decide keep/strip per turn, then strip at the entry level.
  // KEEP thinking only where the API structurally requires it: the turn is answered
  // by a tool_result, or it ends in a still-pending tool_use (dangling loop at the tail).
  const turnMustKeepThinking = new Map<string, boolean>()
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i].obj
    if (!o || o.type !== 'assistant') continue
    const id = o.message?.id
    if (!id || turnMustKeepThinking.has(id)) continue

    let lastIdx = i
    let hasToolUse = false
    for (let j = i; j < parsed.length; j++) {
      const e = parsed[j].obj
      if (e?.type === 'assistant' && e.message?.id === id) {
        lastIdx = j
        if (blocks(e).some((b) => b.type === 'tool_use')) hasToolUse = true
      }
    }

    let nextUser: JsonlEntry | null = null
    for (let j = lastIdx + 1; j < parsed.length; j++) {
      const e = parsed[j].obj
      if (e?.type === 'user' && blocks(e).length > 0) {
        nextUser = e
        break
      }
    }

    const keep = nextUser ? isUserWithToolResult(nextUser) : hasToolUse
    turnMustKeepThinking.set(id, keep)
  }

  // Strip thinking blocks from turns that don't need them; collect emptied entries.
  const dropParent = new Map<string, string | null>() // uuid -> its parentUuid
  let changed = 0
  for (const p of parsed) {
    const o = p.obj
    if (!o || o.type !== 'assistant') continue
    const id = o.message?.id
    if (!id || turnMustKeepThinking.get(id)) continue
    const content = blocks(o)
    if (!content.some(isThinking)) continue
    const kept = content.filter((b) => !isThinking(b))
    o.message!.content = kept
    p.line = JSON.stringify(o)
    changed++
    if (kept.length === 0 && o.uuid) dropParent.set(o.uuid, o.parentUuid ?? null)
  }
  if (changed === 0) return 0

  // Relink parentUuid past any dropped (emptied) entries.
  const resolve = (par: string | null | undefined): string | null => {
    let p: string | null | undefined = par
    const seen = new Set<string>()
    while (typeof p === 'string' && dropParent.has(p) && !seen.has(p)) {
      seen.add(p)
      p = dropParent.get(p) ?? null
    }
    return p ?? null
  }

  const out: string[] = []
  for (const p of parsed) {
    const o = p.obj
    if (o?.uuid && dropParent.has(o.uuid)) continue // dropped
    if (o) {
      const np = resolve(o.parentUuid)
      if (np !== (o.parentUuid ?? null)) {
        o.parentUuid = np
        out.push(JSON.stringify(o))
        continue
      }
    }
    out.push(p.line)
  }

  try {
    writeFileSync(path + '.deckbak', raw)
  } catch {
    // best-effort backup
  }
  writeFileSync(path, out.join('\n'))
  return changed
}

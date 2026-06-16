import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PreviewSource, PreviewSourceWire } from '@decky/shared'
import { isGeneratedCardPath } from '@decky/shared/node'
import { registerPreviewResolution } from './card-mirror'

// State + helpers puros do preview-server. O transport HTTP (em src/main/preview-server.ts)
// vai ser substituído por WS na fase 2; este state já fica pronto pra ser consumido pelos
// dois transports.

const previews = new Map<string, PreviewSource>()
const sessionTitles = new Map<string, string>()

export function getPreviewSources(): Record<string, PreviewSource> {
  return Object.fromEntries(previews)
}

export function getPreviewSource(sessionId: string): PreviewSource | undefined {
  return previews.get(sessionId)
}

export function setPreviewSource(sessionId: string, source: PreviewSource): void {
  previews.set(sessionId, source)
}

export function clearPreviewSource(sessionId: string): PreviewSource {
  const cleared: PreviewSource = { type: 'none' }
  previews.set(sessionId, cleared)
  return cleared
}

export function getSessionTitles(): Record<string, string> {
  return Object.fromEntries(sessionTitles)
}

export function setSessionTitle(id: string, title: string): void {
  sessionTitles.set(id, title)
}

/**
 * Re-read markdown sources that were persisted as just a path (no content).
 * Paths persisted as relative are resolved against `workspace` so cards survive
 * the workspace folder being renamed/moved.
 */
export async function rehydratePreviews(
  byCard: Record<string, Record<string, PreviewSource>>,
  workspace?: string
): Promise<Record<string, Record<string, PreviewSource>>> {
  const out: Record<string, Record<string, PreviewSource>> = {}
  for (const [sessionId, cards] of Object.entries(byCard ?? {})) {
    out[sessionId] = {}
    for (const [cardId, source] of Object.entries(cards)) {
      if (source.type === 'markdown' && source.path && !source.content) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        try {
          const content = await readFile(abs, 'utf-8')
          // Generated card files (<workspace>/.decky/cards/<id>.md) have meaningless
          // basenames. Drop a title that's just the filename so it derives from the content
          // (heading / first line); keep a real custom title if the bot set one.
          const generated = isGeneratedCardPath(abs)
          const bn = basename(abs)
          let title = source.title
          if (generated && (!title || title === bn)) title = undefined
          else if (!generated && !title) title = bn
          out[sessionId][cardId] = { type: 'markdown', content, title, path: abs }
        } catch {
          out[sessionId][cardId] = {
            type: 'markdown',
            content: `*(arquivo não encontrado: ${abs})*`,
            path: abs
          }
        }
      } else if (source.type === 'editor' && source.path && !source.content) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        try {
          const content = await readFile(abs, 'utf-8')
          out[sessionId][cardId] = {
            type: 'editor',
            content,
            title: source.title ?? basename(abs),
            path: abs
          }
        } catch {
          out[sessionId][cardId] = {
            type: 'editor',
            content: '',
            title: source.title ?? basename(abs),
            path: abs
          }
        }
      } else if (source.type === 'xlsx' && source.path) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        out[sessionId][cardId] = {
          type: 'xlsx',
          path: abs,
          title: source.title ?? basename(abs)
        }
      } else if (source.type === 'html' && source.path) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        out[sessionId][cardId] = {
          type: 'html',
          path: abs,
          title: source.title ?? basename(abs),
          favicon: source.favicon ?? null
        }
      } else {
        out[sessionId][cardId] = source
      }
    }
  }
  return out
}

export async function normalizePreviewSource(wire: PreviewSourceWire): Promise<PreviewSource> {
  if (wire.type === 'markdown') {
    if (wire.content != null) {
      return { type: 'markdown', content: wire.content, title: wire.title }
    }
    if (wire.path) {
      const content = await readFile(wire.path, 'utf-8')
      return {
        type: 'markdown',
        content,
        title: wire.title ?? basename(wire.path),
        path: wire.path
      }
    }
    throw new Error('markdown source requires content or path')
  }
  if (wire.type === 'diff') {
    if (wire.content != null) {
      return { type: 'diff', content: wire.content, title: wire.title }
    }
    if (wire.path) {
      const content = await readFile(wire.path, 'utf-8')
      return { type: 'diff', content, title: wire.title ?? basename(wire.path), path: wire.path }
    }
    throw new Error('diff source requires content or path')
  }
  if (wire.type === 'editor') {
    if (!wire.path) throw new Error('editor source requires a path')
    const content = await readFile(wire.path, 'utf-8')
    return { type: 'editor', content, title: wire.title ?? basename(wire.path), path: wire.path }
  }
  if (wire.type === 'xlsx') {
    if (!wire.path) throw new Error('xlsx source requires a path')
    // Binary — don't read here; the renderer reads via file:read-binary on mount.
    await stat(wire.path)
    return { type: 'xlsx', path: wire.path, title: wire.title ?? basename(wire.path) }
  }
  if (wire.type === 'web' && !wire.url) {
    throw new Error('web source requires a url')
  }
  if (wire.type === 'html') {
    // Inline HTML (no path) — used by preview_html. Renderer materializes content to disk.
    if (wire.content != null && !wire.path) {
      return { type: 'html', content: wire.content, title: wire.title }
    }
    if (!wire.path) throw new Error('html source requires a path or content')
    // Stat como fail-fast pra paths LOCAIS — arquivo missing daria 404 silencioso dentro do
    // card. Pra paths de workspace remoto (ex: /home/pi/me/.decky/cards/foo.html) o stat dá
    // ENOENT no host do preview-server (Mac), mas o card:// resolver remoto lê via WS no
    // engine dono. Engole o ENOENT — se o arquivo realmente não existir no remote, o WS
    // read no card:// retorna 404 visível no DevTools, o que é tão útil quanto o fail-fast.
    try {
      await stat(wire.path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'EACCES') throw err
    }
    return { type: 'html', path: wire.path, title: wire.title ?? basename(wire.path) }
  }
  return wire as PreviewSource
}

// Helper que combina: setPreviewSource + register resolver pra reqId + invoca callback de
// broadcast (que o shim Electron implementa como webContents.send). Promise resolve quando o
// renderer faz ack via 'preview:resolved' → applyPreviewResolved → o resolver registrado aqui.
export async function parkPreviewAndAwait(
  broadcast: (sessionId: string, cardId: string | null, source: PreviewSource, reqId: string) => void,
  sessionId: string,
  cardId: string | null,
  source: PreviewSource
): Promise<{ cardId: string; path?: string; title?: string }> {
  previews.set(sessionId, source)
  const reqId = randomUUID()
  return new Promise((resolve) => {
    registerPreviewResolution(reqId, resolve)
    broadcast(sessionId, cardId, source, reqId)
  })
}

// ── Form flow ──────────────────────────────────────────────────────────────
// MCP `prompt_form` tool faz long-poll em /form/await com um formId; renderer faz
// POST /form/submit ou /form/cancel quando o user clica. A Promise abaixo é a parte de espera.

export type FormOutcome =
  | { status: 'submitted'; values: Record<string, string | boolean> }
  | { status: 'cancelled' }
  | { status: 'timeout' }

const pendingForms = new Map<
  string,
  { resolve: (r: FormOutcome) => void; timer: NodeJS.Timeout }
>()

export function isFormPending(formId: string): boolean {
  return pendingForms.has(formId)
}

export function awaitFormOutcome(formId: string, timeoutMs: number): Promise<FormOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingForms.delete(formId)
      resolve({ status: 'timeout' })
    }, timeoutMs)
    pendingForms.set(formId, { resolve, timer })
  })
}

export function submitFormOutcome(
  formId: string,
  values: Record<string, string | boolean>
): boolean {
  const pending = pendingForms.get(formId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingForms.delete(formId)
  pending.resolve({ status: 'submitted', values })
  return true
}

export function cancelFormOutcome(formId: string): boolean {
  const pending = pendingForms.get(formId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingForms.delete(formId)
  pending.resolve({ status: 'cancelled' })
  return true
}

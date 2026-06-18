import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md')

// Markers do bloco que versões anteriores instalavam no CLAUDE.md GLOBAL.
const MARKER_START = '<!-- decky:auto-start — editado pelo decky, não remova os markers -->'
const MARKER_END = '<!-- decky:auto-end -->'
// Markers pre-rename (deck → decky).
const LEGACY_START_PREFIX = '<!-- deck:auto-start'
const LEGACY_END = '<!-- deck:auto-end -->'

// Remove o trecho entre startNeedle..endNeedle (inclusive), colando as bordas com no máximo uma
// linha em branco. No-op se qualquer marker não existir.
function stripBlock(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle)
  if (start === -1) return text
  const end = text.indexOf(endNeedle, start)
  if (end === -1) return text
  const before = text.slice(0, start).replace(/\s*$/, '')
  const after = text.slice(end + endNeedle.length).replace(/^\s*/, '')
  return before && after ? `${before}\n\n${after}` : before + after
}

/**
 * A instrução do decky MIGROU pro contexto injetado pelo hook de SessionStart (ver hooks-installer
 * → `decky claude-context`), que só roda DENTRO das sessões do decky. O ~/.claude/CLAUDE.md é
 * global — manter a instrução lá poluía toda sessão claude da máquina, mesmo fora do decky.
 *
 * Esta função agora só LIMPA: remove qualquer bloco decky (atual ou legacy pre-rename) que
 * instalações anteriores tenham deixado no CLAUDE.md, preservando todo o resto. Idempotente.
 */
export async function removeDeckInstruction(): Promise<void> {
  let existing: string
  try {
    existing = await readFile(CLAUDE_MD, 'utf-8')
  } catch {
    return // sem arquivo (ENOENT) ou ilegível — nada a limpar
  }

  let next = stripBlock(existing, MARKER_START, MARKER_END)
  next = stripBlock(next, LEGACY_START_PREFIX, LEGACY_END)
  if (next.length && !next.endsWith('\n')) next += '\n'

  if (next === existing) return
  await writeFile(CLAUDE_MD, next)
  console.log(`[claude-md-installer] removed decky instruction block from ${CLAUDE_MD}`)
}

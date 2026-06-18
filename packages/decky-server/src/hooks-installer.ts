import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

// Embedded as a trailing shell comment in the hook command. Used to find
// and replace prior decky-managed hooks on subsequent installs without
// touching hooks the user added by hand.
const SENTINEL = 'decky:auto-managed-hook'

// Gated em $DECKY_SESSION_ID (só setado nos terminais do decky) — o settings.json é global, então
// sem o gate o nudge dispararia em QUALQUER sessão claude da máquina. `|| true` normaliza o exit
// quando o gate falha (fora do decky).
const READ_MD_NUDGE = `[ -n "$DECKY_SESSION_ID" ] && jq -rc 'if ((.tool_input.file_path // "") | test("\\\\.md$")) then {hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"Decky reminder: se o usuário pediu para *ver/mostrar/abrir* este .md, use mcp__decky__preview_show em vez de Read — Read traz o conteúdo só para o teu contexto, não exibe ao usuário. Read continua certo se você precisa processar/editar/grep o arquivo."}} else empty end' 2>/dev/null || true # ${SENTINEL}`

// SessionStart: injeta o contexto da sessão decky (capacidades do MCP, decky, widgets, etc) —
// substitui o bloco que antes ficava no ~/.claude/CLAUDE.md GLOBAL. O gate aqui é o próprio
// decky: ele só está no PATH dentro do decky → fora, "command not found" → stdout vazio → nada
// injetado. `|| true` evita ruído de exit não-zero fora do decky.
const SESSION_CONTEXT_HOOK = `decky claude-context 2>/dev/null || true # ${SENTINEL}`

type HookCommand = { type: 'command'; command: string; [k: string]: unknown }
type HookEntry = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
type Settings = {
  hooks?: {
    PreToolUse?: HookEntry[]
    SessionStart?: HookEntry[]
    [k: string]: HookEntry[] | undefined
  }
  [k: string]: unknown
}

// Garante UM entry decky-gerenciado numa lista de hooks (PreToolUse[matcher] ou SessionStart):
// remove os antigos marcados com SENTINEL e adiciona o command novo, preservando hooks do usuário.
function upsertDeckyHook(entries: HookEntry[], matcher: string | undefined, command: string): void {
  let entry = entries.find((e) => e?.matcher === matcher)
  if (!entry) {
    entry = matcher ? { matcher, hooks: [] } : { hooks: [] }
    entries.push(entry)
  }
  entry.hooks ??= []
  entry.hooks = entry.hooks.filter((h) => !isDeckyManaged(h))
  entry.hooks.push({ type: 'command', command })
}

function isDeckyManaged(h: unknown): boolean {
  return (
    typeof h === 'object' &&
    h !== null &&
    typeof (h as HookCommand).command === 'string' &&
    (h as HookCommand).command.includes(SENTINEL)
  )
}

/**
 * Ensure the global ~/.claude/settings.json contains decky's managed hooks
 * (currently: PreToolUse/Read nudge towards preview_show for .md files).
 *
 * Idempotent: only writes when content changed. Preserves any other hooks
 * the user added by hand — only decky-marked entries (SENTINEL in command)
 * are touched.
 */
export async function ensureDeckyHooks(): Promise<void> {
  let originalText = ''
  let settings: Settings = {}
  try {
    originalText = await readFile(SETTINGS_PATH, 'utf-8')
    settings = JSON.parse(originalText) as Settings
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      settings = {}
    } else if (err instanceof SyntaxError) {
      console.warn(`[hooks-installer] ${SETTINGS_PATH} is malformed JSON, skipping`)
      return
    } else {
      console.warn(`[hooks-installer] couldn't read ${SETTINGS_PATH}:`, err)
      return
    }
  }

  const before = JSON.stringify(settings)

  settings.hooks ??= {}
  settings.hooks.PreToolUse ??= []
  settings.hooks.SessionStart ??= []

  // PreToolUse/Read → nudge pro preview_show em .md (gated em $DECKY_SESSION_ID).
  upsertDeckyHook(settings.hooks.PreToolUse, 'Read', READ_MD_NUDGE)
  // SessionStart (sem matcher = todas as fontes: startup/resume/clear) → contexto da sessão decky.
  upsertDeckyHook(settings.hooks.SessionStart, undefined, SESSION_CONTEXT_HOOK)

  if (JSON.stringify(settings) === before) return

  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
  console.log(`[hooks-installer] updated ${SETTINGS_PATH} with decky-managed hooks`)
}

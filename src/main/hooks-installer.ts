import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

// Embedded as a trailing shell comment in the hook command. Used to find
// and replace prior decky-managed hooks on subsequent installs without
// touching hooks the user added by hand.
const SENTINEL = 'decky:auto-managed-hook'

const READ_MD_NUDGE = `jq -rc 'if ((.tool_input.file_path // "") | test("\\\\.md$")) then {hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"Decky reminder: se o usuário pediu para *ver/mostrar/abrir* este .md, use mcp__decky__preview_show em vez de Read — Read traz o conteúdo só para o teu contexto, não exibe ao usuário. Read continua certo se você precisa processar/editar/grep o arquivo."}} else empty end' 2>/dev/null # ${SENTINEL}`

type HookCommand = { type: 'command'; command: string; [k: string]: unknown }
type HookEntry = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
type Settings = {
  hooks?: { PreToolUse?: HookEntry[]; [k: string]: HookEntry[] | undefined }
  [k: string]: unknown
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

  let readEntry = settings.hooks.PreToolUse.find((e) => e?.matcher === 'Read')
  if (!readEntry) {
    readEntry = { matcher: 'Read', hooks: [] }
    settings.hooks.PreToolUse.push(readEntry)
  }
  readEntry.hooks ??= []
  readEntry.hooks = readEntry.hooks.filter((h) => !isDeckyManaged(h))
  readEntry.hooks.push({ type: 'command', command: READ_MD_NUDGE })

  if (JSON.stringify(settings) === before) return

  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
  console.log(`[hooks-installer] updated ${SETTINGS_PATH} with decky-managed hooks`)
}

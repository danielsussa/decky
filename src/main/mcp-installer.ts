import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_PATH = join(homedir(), '.claude.json')
// A DECKY_DEV instance registers under its own name + port so it never clobbers the
// stable app's MCP registration (both live in the global ~/.claude.json).
const SERVER_NAME = process.env.DECKY_DEV ? 'decky-dev' : 'decky'
// Old names from before the deck→decky rename; removed on registration so they don't linger.
const LEGACY_NAMES = ['deck', 'deck-dev']

interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

function envsEqual(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}

function serversEqual(a: McpServerConfig | undefined, b: McpServerConfig): boolean {
  if (!a) return false
  if (a.command !== b.command) return false
  if (a.args.length !== b.args.length) return false
  for (let i = 0; i < a.args.length; i++) if (a.args[i] !== b.args[i]) return false
  return envsEqual(a.env, b.env)
}

/**
 * Auto-register the dk-mcp server in ~/.claude.json so Claude Code picks it up on next start.
 * Idempotent: no write if already matches.
 */
export async function ensureDeckMcpRegistered(serverScriptPath: string): Promise<void> {
  let config: ClaudeConfig = {}
  try {
    const text = await readFile(CONFIG_PATH, 'utf-8')
    config = JSON.parse(text) as ClaudeConfig
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[mcp-installer] couldn't parse ${CONFIG_PATH}, starting fresh:`, err)
    }
    // fresh config
  }

  config.mcpServers = config.mcpServers ?? {}

  const desired: McpServerConfig = {
    command: 'node',
    args: [serverScriptPath]
  }
  // Point the spawned dk-mcp at THIS instance's preview server (dev uses 6791).
  if (process.env.DECKY_URL) desired.env = { DECKY_URL: process.env.DECKY_URL }

  const hasLegacy = LEGACY_NAMES.some((n) => config.mcpServers![n])
  if (!hasLegacy && serversEqual(config.mcpServers[SERVER_NAME], desired)) return

  for (const n of LEGACY_NAMES) delete config.mcpServers[n]
  config.mcpServers[SERVER_NAME] = desired

  const tmp = CONFIG_PATH + '.decky-tmp'
  await writeFile(tmp, JSON.stringify(config, null, 2))
  await rename(tmp, CONFIG_PATH)

  console.log(
    `[mcp-installer] registered "${SERVER_NAME}" MCP server → ${serverScriptPath}\n` +
      `[mcp-installer] restart any open \`claude\` session to pick it up.`
  )
}

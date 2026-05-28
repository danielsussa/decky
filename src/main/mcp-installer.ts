import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_PATH = join(homedir(), '.claude.json')
const SERVER_NAME = 'deck'

interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

function serversEqual(a: McpServerConfig | undefined, b: McpServerConfig): boolean {
  if (!a) return false
  if (a.command !== b.command) return false
  if (a.args.length !== b.args.length) return false
  for (let i = 0; i < a.args.length; i++) if (a.args[i] !== b.args[i]) return false
  return true
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

  if (serversEqual(config.mcpServers[SERVER_NAME], desired)) return

  config.mcpServers[SERVER_NAME] = desired

  const tmp = CONFIG_PATH + '.deck-tmp'
  await writeFile(tmp, JSON.stringify(config, null, 2))
  await rename(tmp, CONFIG_PATH)

  console.log(
    `[mcp-installer] registered "${SERVER_NAME}" MCP server → ${serverScriptPath}\n` +
      `[mcp-installer] restart any open \`claude\` session to pick it up.`
  )
}

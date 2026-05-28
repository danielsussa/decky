import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md')

const MARKER_START = '<!-- deck:auto-start — editado pelo deck, não remova os markers -->'
const MARKER_END = '<!-- deck:auto-end -->'

const BLOCK_BODY = `## deck (auto-instalado)

Este shell pode estar rodando dentro do **deck** (casca Electron com painel de preview à direita do terminal). Quando o servidor MCP \`deck\` aparecer em \`mcp__deck__*\`, ele tem ferramentas para **mostrar** conteúdo ao usuário em vez de só ler.

- **\`preview_show\`** — quando o usuário pedir para *ver / mostrar / abrir* um arquivo (\`.md\`, \`.json\`), use **esta** tool em vez de \`Read\`. \`Read\` traz o conteúdo pro teu contexto mas o usuário **não vê** o arquivo formatado; \`preview_show\` exibe no painel central da casca.
- \`Read\` continua certo quando você precisa **processar** o conteúdo (parse, edit, search, grep).
- Outras tools do MCP deck: \`preview_markdown\` (conteúdo inline), \`preview_json\` (tree colapsível, melhor que cuspir JSON gigante no terminal), \`preview_me\` (volta pro Live View do me daemon), \`preview_hide\`.
- Se o MCP \`deck\` não estiver disponível (ex.: shell fora do deck, ou deck não iniciado), use \`Read\` normalmente — sem reclamar.
`

const BLOCK = `${MARKER_START}\n${BLOCK_BODY}${MARKER_END}\n`

/**
 * Ensure the global ~/.claude/CLAUDE.md contains an up-to-date deck instruction block.
 * Idempotent: only writes when content changed. Preserves any other content the user has.
 */
export async function ensureDeckInstruction(): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(CLAUDE_MD, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[claude-md-installer] couldn't read ${CLAUDE_MD}:`, err)
      return
    }
  }

  let next: string
  const startIdx = existing.indexOf(MARKER_START)
  if (startIdx === -1) {
    // append (with separator if there's prior content)
    next = existing
      ? existing.replace(/\s*$/, '') + '\n\n' + BLOCK
      : BLOCK
  } else {
    const endIdx = existing.indexOf(MARKER_END, startIdx)
    if (endIdx === -1) {
      // corrupted: missing end marker — append fresh, leave broken block alone
      next = existing.replace(/\s*$/, '') + '\n\n' + BLOCK
    } else {
      const before = existing.slice(0, startIdx)
      const after = existing.slice(endIdx + MARKER_END.length)
      next = before + BLOCK.trimEnd() + after.replace(/^\s*/, '\n') + (after.endsWith('\n') ? '' : '\n')
    }
  }

  if (next === existing) return

  await mkdir(dirname(CLAUDE_MD), { recursive: true })
  await writeFile(CLAUDE_MD, next)
  console.log(`[claude-md-installer] updated ${CLAUDE_MD} with deck instruction block`)
}

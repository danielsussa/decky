import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md')

const MARKER_START = '<!-- decky:auto-start — editado pelo decky, não remova os markers -->'
const MARKER_END = '<!-- decky:auto-end -->'

// Pre-rename block markers — stripped on install so we don't leave a stale `deck` block.
const LEGACY_START_PREFIX = '<!-- deck:auto-start'
const LEGACY_END = '<!-- deck:auto-end -->'

const BLOCK_BODY = `## decky (auto-instalado)

Este shell pode estar rodando dentro do **decky** (casca Electron com painel de preview à direita do terminal). Quando o servidor MCP \`decky\` aparecer em \`mcp__decky__*\`, ele tem ferramentas para **mostrar** conteúdo ao usuário em vez de só ler.

- **\`preview_show\`** — quando o usuário pedir para *ver / mostrar / abrir* um arquivo (\`.md\`, \`.json\`), use **esta** tool em vez de \`Read\`. \`Read\` traz o conteúdo pro teu contexto mas o usuário **não vê** o arquivo formatado; \`preview_show\` exibe no painel central da casca.
- \`Read\` continua certo quando você precisa **processar** o conteúdo (parse, edit, search, grep).
- Outras tools do MCP decky: \`preview_markdown\` (conteúdo inline), \`preview_json\` (tree colapsível, melhor que cuspir JSON gigante no terminal), \`preview_me\` (volta pro Live View do me daemon), \`preview_hide\`.
- **\`preview_diff\`** — pra mostrar mudanças de código (saída de \`git diff\`/\`git show\`/\`diff -u\`), use **esta** tool, passando o texto do diff cru. Renderiza estruturado (header por arquivo com +/-, gutter de linhas, linhas verdes/vermelhas) — **nunca** jogue o diff num bloco markdown \`\`\`diff, fica muito pior.
- **Manter o card em sincronia depois de atuar**: um card NÃO se atualiza a partir do teu raciocínio — só um card de arquivo se auto-recarrega, e só quando o arquivo muda no disco. \`preview_show(path)\` faz live-reload a cada save (é só seguir editando o arquivo, sem re-renderizar). Já \`preview_markdown\` é materializado automaticamente em \`.decky/cards/<id>.md\` e a resposta da tool te diz **\`card '<id>' at <path>\`** — depois disso, **edite esse arquivo com \`Edit\`** (card live-reload pega no save). \`preview_json\` continua sendo snapshot inline: pra atualizar, chame a tool de novo com \`card: '<mesmo id>'\` e o valor novo.
- **Descobrir o que o usuário tem aberto**: se o usuário pedir "atualiza aquele card / arruma o típo daquela lista" e você não tem o id na mão, chame \`list_cards\` — devolve id, type, title, path (quando aplicável), focused e pinned de tudo que está aberto nessa sessão. Pra cards markdown, o \`path\` retornado já é editável com \`Edit\`.
- **Biblioteca de cards**: os cards que você cria são arquivos \`.md\` reais no \`.decky/cards/\` do projeto (a env var \`$DECKY_CARDS_DIR\` tem o caminho absoluto), compartilhados entre todas as sessions do workspace. Antes de gerar um doc do zero, dê um Glob \`$DECKY_CARDS_DIR/**/*.md\` e reaproveite/edite o existente. \`$DECKY_CARDS_DIR/PINNED.md\` lista os cards fixados (contexto sempre relevante).
- Se o MCP \`decky\` não estiver disponível (ex.: shell fora do decky, ou decky não iniciado), use \`Read\` normalmente — sem reclamar.
`

const BLOCK = `${MARKER_START}\n${BLOCK_BODY}${MARKER_END}\n`

// Remove the pre-rename `deck` auto block, if present, so the rename leaves no stale copy.
function stripLegacyBlock(text: string): string {
  const start = text.indexOf(LEGACY_START_PREFIX)
  if (start === -1) return text
  const endMarker = text.indexOf(LEGACY_END, start)
  if (endMarker === -1) return text
  const before = text.slice(0, start)
  const after = text.slice(endMarker + LEGACY_END.length)
  return before.replace(/\s*$/, '') + after.replace(/^\s*/, after && before ? '\n\n' : '')
}

/**
 * Ensure the global ~/.claude/CLAUDE.md contains an up-to-date decky instruction block.
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

  const original = existing
  existing = stripLegacyBlock(existing)

  let next: string
  const startIdx = existing.indexOf(MARKER_START)
  if (startIdx === -1) {
    // append (with separator if there's prior content)
    next = existing ? existing.replace(/\s*$/, '') + '\n\n' + BLOCK : BLOCK
  } else {
    const endIdx = existing.indexOf(MARKER_END, startIdx)
    if (endIdx === -1) {
      // corrupted: missing end marker — append fresh, leave broken block alone
      next = existing.replace(/\s*$/, '') + '\n\n' + BLOCK
    } else {
      const before = existing.slice(0, startIdx)
      const after = existing.slice(endIdx + MARKER_END.length)
      next =
        before + BLOCK.trimEnd() + after.replace(/^\s*/, '\n') + (after.endsWith('\n') ? '' : '\n')
    }
  }

  if (next === original) return

  await mkdir(dirname(CLAUDE_MD), { recursive: true })
  await writeFile(CLAUDE_MD, next)
  console.log(`[claude-md-installer] updated ${CLAUDE_MD} with decky instruction block`)
}

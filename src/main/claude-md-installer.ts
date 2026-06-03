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

### Widgets em cards (I/O imperativo)

Alguns cards têm **widgets vivos** — elementos interativos com estado React próprio (flow diagram, checklist, e o que mais for adicionado). Pra mutar widget, use \`card_invoke\` / \`card_get\` em vez de editar o \`.md\` — o widget continua *mounted*, animações fluem, sem reparse do markdown.

**Descobrir o catálogo**: chame \`list_widgets()\` — retorna \`{ types, active }\`.
- \`types\` é o catálogo: cada tipo de widget se auto-documenta com \`fence\` (sintaxe da fence no markdown), \`specSchema\` (formato do JSON), \`ops\` (mutações disponíveis com schema dos args) e \`getters\` (leitura de estado).
- \`active\` lista os widgets já montados nos cards abertos: \`{cardId, widgetId, type}\`.

**Sempre chame \`list_widgets\` antes de adivinhar ops ou montar fence** — o catálogo é a verdade. O bloco aqui no CLAUDE.md não cita widget específico de propósito, pra não envelhecer.

**Criar widget num card**: dentro do \`.md\`, uma fence com o \`type\` (achado no catálogo) + JSON contendo um \`id\`. Ex genérico:

\`\`\`<type>
{ "id": "meu-widget", ... }
\`\`\`

O \`id\` é como você endereça via \`card_invoke(cardId, widgetId, op, args)\` — \`cardId\` é o id do card (.md), \`widgetId\` é o \`id\` no JSON. Sem \`id\` no JSON o widget não se registra e \`card_invoke\` falha com "widget not found".

**Quando usar cada interface**:

- **Editar \`.md\`** (via \`Edit\` tool) — texto estático, headings, parágrafos, OU criar widget novo / mudar shape inicial do widget. O renderer anima fade-in só nos blocos top-level que mudaram (não reparseia o resto).
- **\`card_invoke\`** — mutar estado de widget JÁ montado. Estado é **ephemeral** — sobrevive até o card recarregar; pra persistir, edite o .md depois.
- **\`card_get\`** — ler estado VIVO (ex: posições atuais dos nós depois do usuário arrastar; items checked depois de clique no checkbox).

**Anti-padrão**: editar o \`.md\` pra mutar algo que é estado de widget (toggle checkbox, ativar nó). Funciona mas é coarse, perde a animação, e o usuário enxerga "arquivo mudou" em vez de "item foi tocado". Use \`card_invoke\` com a op apropriada (consulte \`list_widgets\`).

### Prévia antes de enviar mensagem (WhatsApp, email, etc)

Sempre que o usuário pedir para enviar uma mensagem por qualquer canal (WhatsApp, email, SMS, DM — via \`me\`/handoff ou qualquer outro caminho), **NÃO envie direto**. Primeiro renderize um card no decky (painel à direita) com prévia visual da mensagem (destinatário + assunto/contexto + texto), e só envie depois que o usuário apertar SEND. Apertar SEND é o sinal explícito de autorização — evita disparar mensagem com texto errado, destinatário errado, ou quando o usuário mudou de ideia.

- **WhatsApp**: \`preview_markdown\` com header (avatar/inicial + nome + telefone), últimas 3-5 mensagens da conversa como contexto (incoming = bolha cinza à esquerda, outgoing = bolha verde à direita, com timestamps — busque via \`me\`/handoff antes), e a mensagem a enviar como bolha verde no fim com borda tracejada / opacity / label "PRÉVIA".
- **Email**: \`preview_markdown\` com header (\`De:\`, \`Para:\`, \`Cc:\` se houver, \`Assunto:\`) e corpo formatado como vai sair (HTML/markdown renderizado, não cru); se houver thread, mostre os últimos 2-3 emails acima como contexto.
- **Outros canais**: adapte o mockup ao canal, mas mantenha destinatário + contexto + texto sempre visíveis.
- Em seguida, \`prompt_form\` com \`textarea\` pré-preenchido (editável) para o corpo + campo \`text\` mostrando destinatário (e assunto, no email) para revisão. Botão \`submitLabel: "Enviar"\`.
- Respeite o texto final que voltar nos \`values\` (usuário pode ter editado). Cancelar = não enviar; não reenvie sem nova autorização.
- Sem histórico disponível (contato/thread novo, erro no handoff): renderize só o header + prévia e mencione no card que é conversa nova.
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

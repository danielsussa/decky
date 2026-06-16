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

- **\`preview_show\`** — quando o usuário pedir para *ver / mostrar / abrir* um arquivo (\`.html\`, \`.json\`, \`.xlsx\`, \`.diff\`/\`.patch\`, \`.md\` legacy), use **esta** tool em vez de \`Read\`. \`Read\` traz o conteúdo pro teu contexto mas o usuário **não vê** o arquivo formatado; \`preview_show\` exibe no painel central da casca.
- \`Read\` continua certo quando você precisa **processar** o conteúdo (parse, edit, search, grep).
- Outras tools do MCP decky: \`preview_html\` (HTML inline — canônico pra cards novos), \`preview_json\` (tree colapsível, melhor que cuspir JSON gigante no terminal), \`preview_me\` (volta pro Live View do me daemon), \`preview_hide\`. \`preview_markdown\` foi descontinuado em 2026-06-16 — chame \`preview_html\` no lugar.
- **\`preview_diff\`** — pra mostrar mudanças de código (saída de \`git diff\`/\`git show\`/\`diff -u\`), use **esta** tool, passando o texto do diff cru. Renderiza estruturado (header por arquivo com +/-, gutter de linhas, linhas verdes/vermelhas) — **nunca** jogue o diff num bloco markdown \`\`\`diff, fica muito pior.
- **Manter o card em sincronia depois de atuar**: um card NÃO se atualiza a partir do teu raciocínio — só um card de arquivo se auto-recarrega, e só quando o arquivo muda no disco. \`preview_show(path)\` faz live-reload a cada save (é só seguir editando o arquivo, sem re-renderizar). Já \`preview_html\` materializa o conteúdo automaticamente em \`.decky/cards/<id>.html\` e a resposta da tool te diz **\`card '<id>' at <path>\`** — pra atualizar, edita o \`.html\` diretamente (live-reload pega no save). \`preview_json\` continua sendo snapshot inline: pra atualizar, chame a tool de novo com \`card: '<mesmo id>'\` e o valor novo.
- **\`preview_html\` aceita fragment OU documento completo**: se o \`content\` começar com \`<!doctype\` ou \`<html\`, ele é usado como está. Senão é envolvido no scaffold padrão (\`/__decky/default.css\`, body com padding). Em ambos os casos, o renderer escaneia o conteúdo por \`data-decky-<nome>\` e auto-injeta \`<script src="/__decky/widgets/<nome>.js">\` antes de \`</body>\` — não precisa lembrar de incluir scripts dos widgets, é automático.
- **Contexto da sessão = SÓ o card focado**: o usuário aponta UM card por sessão (a tab destacada no painel) e ESSE é o contexto. Outras tabs abertas existem mas NÃO contam — o usuário não tá pedindo pra você olhar elas. Chame \`list_cards\` **proativamente** pra descobrir o card focado quando: (1) a pergunta tem pouco contexto e parece esperar contexto prévio — ex "vamos voltar pra esse assunto?", "e aí?", "continua", "o que falta?" sem antecedente nesta conversa; (2) a pergunta referencia algo via demonstrativo ambíguo — "esse / essa / aquele / isso aí / o doc / aquela lista / o card" sem você ter id na mão; (3) o pedido é editar/atualizar algo que claramente não é desta conversa. Retorno: \`{ card }\` (único card focado) ou \`{ card: null }\` se nenhum tá focado. Pra HTML o \`path\` já é editável com \`Edit\`. Pra achar OUTRO card que não tá focado, use \`search_cards\` — não tente "listar tudo". **Não** chame se a pergunta é autocontida (instrução clara, contexto suficiente nesta conversa, trabalho técnico em arquivos do código).
- **Biblioteca de cards**: os cards que você cria são arquivos \`.html\` reais no \`.decky/cards/\` do projeto (a env var \`$DECKY_CARDS_DIR\` tem o caminho absoluto), compartilhados entre todas as sessions do workspace. Antes de gerar um doc do zero, dê um Glob \`$DECKY_CARDS_DIR/**/*.html\` e reaproveite/edite o existente. \`$DECKY_CARDS_DIR/PINNED.md\` é o único \`.md\` legítimo (index de pinned, não é card).
- Se o MCP \`decky\` não estiver disponível (ex.: shell fora do decky, ou decky não iniciado), use \`Read\` normalmente — sem reclamar.

### Widgets em cards HTML

Cards HTML podem ter **widgets vivos** — elementos interativos renderizados por um runtime vanilla JS servido em \`/__decky/widgets/<nome>.js\`. Atualmente: \`matrix\` (matriz de decisão), \`roadmap\` (timeline com deps), \`checklist\` (lista com persistência), \`flow\` (diagrama bezier), \`mermaid\`.

**Descobrir o catálogo**: chame \`list_widgets()\` — retorna \`{ types, active }\`.
- \`types\` é o catálogo: cada tipo de widget se auto-documenta com nome, descrição, \`specSchema\` (formato do JSON), ops e getters.
- \`active\` lista os widgets já montados em cards abertos.

**Sempre chame \`list_widgets\` antes de adivinhar specs** — o catálogo é a verdade.

**Criar widget num card HTML**: dentro do HTML, um \`<div data-decky-<nome>>{...JSON spec...}</div>\`. O JSON precisa ter \`id\` se você quer endereçar o widget depois. Ex:

\`\`\`html
<div data-decky-matrix>
{ "id": "meu-widget", "options": [...], "criteria": [...], "scores": {...} }
</div>
\`\`\`

O \`<script src="/__decky/widgets/matrix.js">\` é **auto-injetado** pelo \`preview_html\` — não precisa adicionar manualmente.

**Spec \`readonly: true\`** desabilita a interação do usuário (inputs/botões viram disabled, badge "AI-only" aparece) — útil pra dashboards/análises que a AI mantém e o user só observa.

**I/O imperativo (\`card_invoke\` / \`card_get\`)**: hoje conectado só pra widgets renderizados em-app (React side — flow + checklist em cards \`.md\` legacy). Vanilla widgets em HTML mini-app **ainda não** expõem ops via MCP — pra mutar, edite o JSON do \`<div data-decky-*>\` no \`.html\` direto. Quando a bridge postMessage chegar (planejado), \`card_invoke\` passa a funcionar igual.

**Anti-padrão**: tentar invocar op num widget vanilla via \`card_invoke\` — vai dar "no active window or ws client" ou timeout. Edite o JSON da spec no HTML.

### Prévia antes de enviar mensagem (WhatsApp, email, etc)

Sempre que o usuário pedir para enviar uma mensagem por qualquer canal (WhatsApp, email, SMS, DM — via \`me\`/handoff ou qualquer outro caminho), **NÃO envie direto**. Primeiro renderize um card no decky (painel à direita) com prévia visual da mensagem (destinatário + assunto/contexto + texto), e só envie depois que o usuário apertar SEND. Apertar SEND é o sinal explícito de autorização — evita disparar mensagem com texto errado, destinatário errado, ou quando o usuário mudou de ideia.

- **WhatsApp**: \`preview_html\` com header (avatar/inicial + nome + telefone), últimas 3-5 mensagens da conversa como contexto (incoming = bolha cinza à esquerda, outgoing = bolha verde à direita, com timestamps — busque via \`me\`/handoff antes), e a mensagem a enviar como bolha verde no fim com borda tracejada / opacity / label "PRÉVIA".
- **Email**: \`preview_html\` com header (\`De:\`, \`Para:\`, \`Cc:\` se houver, \`Assunto:\`) e corpo formatado como vai sair (HTML, não cru); se houver thread, mostre os últimos 2-3 emails acima como contexto.
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

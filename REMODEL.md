# Remodel: instância única + workspaces dentro + estado em `~/.deck`

Roadmap do remodel do deck pra **instância única** (o oposto do VS Code: nunca janela-por-pasta;
abre N workspaces *dentro* da mesma instância) com o estado centralizado em `~/.deck`.

## Decisões (fechadas)

- **Instância única, por-identidade.** O lock é por `userData`; cada *identidade* (estável vs dev)
  é um singleton separado. Relançar foca/roteia, nunca abre processo novo.
- **Modelo HÍBRIDO de estado** (revisado — antes era tudo centralizado):
  - **Global (`~/.deck/state.json`)**: config de máquina — registry de workspaces + keymap. Não portável.
  - **In-project (`<pasta>/.deck/`)**: estado daquele workspace (`workspace.json`) + `cards/`. **Viaja com o
    projeto** (git/clone), some quando a pasta é apagada, sem órfãos nem slug.
  - **gitignore**: o deck escreve `<pasta>/.deck/.gitignore` ignorando `workspace.json`/`*.tmp` mas
    deixando `cards/` versionável (commitar = compartilhar docs do projeto). Contido no `.deck/`,
    não toca o `.gitignore` raiz.
  - **Dev isola por nome de dir**: instância `DECK_DEV` usa `<pasta>/.deck-dev/` (+ `~/.deck-dev` global),
    então pode abrir a mesma pasta que a estável sem conflito.
  - **Sem migração**: in-project já era o lugar original; os `<proj>/.deck` existentes ficam no lugar.
- **Sessões estilo browser (LRU):** ficam *listadas* mas o pty só spawna ao abrir; cap de **N**
  ativas (default 6); abrir além de N mata a inativa mais antiga. Reabrir = `--resume`.
- **Trabalho continua na pasta real:** cada sessão spawna `claude` com `cwd = pasta do workspace`;
  só o bookkeeping do deck (cards/estado) é que centraliza.
- **Dev dogfooding:** `DECK_DEV` namespaceia tudo (`~/.deck-dev`, porta 6791, MCP `deck-dev`,
  userData `deck-dev`) → roda lado a lado com o `deck.app` estável.

## Rename planejado: `deck` → `decky` (futuro)

O produto vai se chamar **decky** (domínio provável **decky.tools**). É um rebrand dedicado,
**separado** deste remodel — quando rolar, toca: `appId`/`productName`, nome do MCP server
(`deck` → `decky`), env vars `DECK_*`, bins `dk`/`dk-mcp` (→ `dky`?), o bloco auto-instalado no
`~/.claude/CLAUDE.md`, o repo GH e o domínio. Enquanto isso, o código segue com `deck`/`deck-dev`.

## Notas

- In-project elimina slug, migração e órfãos. `$DECK_CARDS_DIR` = `<cwd>/.deck/cards` (intuitivo pro bot).
- MCP é registrado global no `~/.claude.json` → uma sessão veria `deck` (6790) e `deck-dev` (6791).
  Ruído aceitável por ora; fix "certo" depois = registrar MCP por-projeto (`.mcp.json`).

---

## Fase 0 — fundação de paths + isolamento dev  ✅ CÓDIGO PRONTO

Baixo risco; destrava dogfoodar as fases seguintes dentro do dev isolado.

- [x] `src/main/paths.ts` *(novo)* — `deckStateDir()`, `workspaceSlug()`, `workspaceDir/cardsDir/statePath()`
- [x] `src/main/state-store.ts` — usar `deckStateDir()` no lugar de `~/.deck` hardcoded
- [x] `src/main/index.ts` — `DECK_DEV` → `setName('deck-dev')` + `userData` próprio (antes do lock)
- [x] `src/main/mcp-installer.ts` — `SERVER_NAME` + `env.DECK_URL` derivados de `DECK_DEV`/`DECK_URL`
- [x] `package.json` — script `dev` com `DECK_DEV=1 DECK_STATE_DIR=~/.deck-dev DECK_PREVIEW_PORT=6791 DECK_URL=…6791`
- [x] validado estático: typecheck/lint + path helpers isolam (`~/.deck` vs `~/.deck-dev`, slug estável por projeto)
- [ ] **validar no GUI (você):** `npm run dev` abre o `deck-dev` junto do `deck.app` estável, isolado

## Fase 1 — estado/cards in-project + main dono dos paths  ✅ CÓDIGO PRONTO

> Revisado: era "centralizar em ~/.deck"; viramos pro **híbrido in-project** (cards/estado na pasta).

- [x] `src/main/paths.ts` — `workspaceDir(cwd)=join(cwd, deckDirName())` (`.deck`/`.deck-dev`); `deckStateDir()` segue global; `isGeneratedCardPath`; slug removido
- [x] `src/main/cards-store.ts` *(novo)* + IPC `cards:write` — main dono do path do card, retorna abs path
- [x] `src/renderer/.../App.tsx` — materialização + PINNED via `window.deck.cards.write`; watch usa path retornado
- [x] `src/main/workspace-store.ts` — grava em `<cwd>/.deck/workspace.json` + escreve `.deck/.gitignore` (mantém `cards/`)
- [x] `src/main/pty.ts` — injeta `DECK_CARDS_DIR=<cwd>/.deck/cards` no env da sessão
- [x] `DECK_SESSION_PROMPT` (App.tsx) + `claude-md-installer.ts` + `bin/dk-mcp` (texto) — usam `$DECK_CARDS_DIR`
- [x] `src/main/preview-server.ts` — detecção de card "generated" via `isGeneratedCardPath`
- [x] ~~migrate.ts~~ removido (in-project já é o lugar original; nada a migrar)
- [x] validado: build (typecheck+bundle) + lint dos arquivos novos/editados limpos

## Fase 2 — instância única + roteamento de workspace  ✅ CÓDIGO PRONTO

- [x] `src/main/index.ts` — `second-instance(argv,cwd)` acha a pasta e roteia via `session:add` (→ setWorkspace); `dialog:pick-folder` IPC
- [x] `src/renderer` — `WorkspaceBar` (switcher: lista workspaces, troca, "Adicionar pasta…"); registry persistido em `~/.deck/state.json`
- [x] validado: typecheck (web+node) + lint limpos

## Fase 3 — sessões estilo browser (LRU)  ✅ CÓDIGO PRONTO

- [x] `App.tsx` — `liveIds` (LRU), cap `MAX_LIVE_SESSIONS=6`; `renderBody` só monta Terminal pras vivas (resto = placeholder, sem pty)
- [x] ativo sempre vivo; promover ativo no LRU; podar fechadas; reabrir suspensa = remount → `--resume` (conversa intacta)
- [x] validado: typecheck (web+node) ok; build bundla. eslint: +3 flags `set-state-in-effect` (mesma regra já presente no L412, não-bloqueante)

---

## Estado: todas as fases com código pronto ✅ — falta validação no GUI (você)

Validar com `npm run dev` (deck-dev isolado) + `npm run build:mac` pro `deck.app`:
1. dev sobe isolado (porta 6791, `~/.deck-dev`, MCP `deck-dev`) junto do estável
2. cards aparecem em `~/.deck/workspaces/<slug>/cards/` (não mais no repo); migração importou `<proj>/.deck` antigo
3. `WorkspaceBar` troca/adiciona pasta; abrir muitas sessões suspende a mais antiga e reabrir retoma a conversa

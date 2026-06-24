import os from 'os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// Shell-adapter registry — a "API de alto nível" do spawn de shell (espelha src/main/web/adapters).
// Cada shell tem semântica de init e de histórico diferente (zsh usa ZDOTDIR, bash usa --rcfile,
// fish usa ~/.config/fish/ e ignora HISTFILE), então NÃO existe um mecanismo único. Em vez de
// crescer um if-cascade no pty-manager, cada shell é um adapter que sabe DUAS coisas:
//   1. como spawnar carregando a config COMPLETA do usuário (login → .zprofile/.bash_profile etc), e
//   2. como injetar os extras do decky: HISTFILE isolado por aba + recall do histórico global +
//      a função `claude()` (vínculo determinístico — ver pty-manager).
// Shell sem adapter cai no FALLBACK: shell de login+interativo puro → a config do usuário carrega
// normal (brew/gh/PATH funcionam), só sem os extras (isolamento de histórico e o shim do claude,
// que segue funcionando via o fallback de birthtime do pty-manager). Adicionar um shell = um adapter
// novo aqui, sem tocar no core.

// Plano de spawn de um shell: argv extra (depois do file) + env extra. O pty-manager mescla isto
// no pty.spawn (env por cima do env base, args como argv do shell).
export interface ShellSpawnPlan {
  args: string[]
  env: Record<string, string>
}

export interface ShellCtx {
  /** id da aba (DECKY_SESSION_ID) — chaveia o HISTFILE isolado. */
  sessionId: string
  /** HISTFILE persistente desta aba (~/.decky/histories/<sessionId>): escrita isolada por aba. */
  histfile: string
}

export interface ShellAdapter {
  id: string
  match: (shellFile: string) => boolean
  plan: (ctx: ShellCtx) => ShellSpawnPlan
}

// ---------------------------------------------------------------------------------------------
// zsh — shim via ZDOTDIR. O /etc/zshrc do macOS força HISTFILE=$HOME/.zsh_history no startup,
// sobrescrevendo qualquer HISTFILE do env; por isso não basta setar HISTFILE — usamos um ZDOTDIR
// "shim" que carrega a config real do usuário e SÓ no fim fixa o HISTFILE da aba e define `claude`.
// ---------------------------------------------------------------------------------------------

// Função `claude` injetada no shim: força um --session-id conhecido e o anuncia pro decky (vínculo
// determinístico aba↔conversa). Passthrough quando o id já vem dado (--resume/--continue/
// --session-id/--from-pr) ou fora de uma sessão decky. `command claude` pula a função e acha o
// binário real (sem loop). Lowercase no uuid pra casar com o basename do .jsonl que o claude cria.
const CLAUDE_SHIM_FN =
  'claude() {\n' +
  '  if [[ -z "$DECKY_SESSION_ID" || -z "$DECKY_CLAUDE_SID_DIR" ]]; then command claude "$@"; return; fi\n' +
  '  local a\n' +
  '  for a in "$@"; do\n' +
  '    case "$a" in -r|--resume|-c|--continue|--session-id|--from-pr) command claude "$@"; return ;; esac\n' +
  '  done\n' +
  '  local sid="$(uuidgen | tr "A-Z" "a-z")"\n' +
  '  mkdir -p "$DECKY_CLAUDE_SID_DIR"\n' +
  '  print -rn -- "$sid" > "$DECKY_CLAUDE_SID_DIR/$DECKY_SESSION_ID"\n' +
  '  command claude --session-id "$sid" "$@"\n' +
  '}\n'

let zshShimDir: string | null = null
function ensureZshShim(): string {
  if (zshShimDir) return zshShimDir
  const dir = join(os.homedir(), '.decky', 'zsh')
  mkdirSync(dir, { recursive: true })
  // .zshenv mantém o ZDOTDIR=shim ativo até o estágio do .zshrc; só carrega o real do usuário.
  writeFileSync(join(dir, '.zshenv'), '[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n')
  // .zshrc: devolve ZDOTDIR pro $HOME (config real e subshells veem o normal), carrega o .zshrc do
  // usuário, define a função `claude` (DEPOIS, pra ganhar de aliases dele) e por ÚLTIMO os extras de
  // histórico: fixa o HISTFILE isolado da aba E dá `fc -R` no ~/.zsh_history global pra recall (a
  // seta-pra-cima/Ctrl-R enxergam o histórico global, mas a ESCRITA continua no arquivo da aba).
  writeFileSync(
    join(dir, '.zshrc'),
    'ZDOTDIR="$HOME"\n' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n' +
      CLAUDE_SHIM_FN +
      '[ -n "$DECKY_HISTFILE" ] && HISTFILE="$DECKY_HISTFILE"\n' +
      '[ -r "$HOME/.zsh_history" ] && fc -R "$HOME/.zsh_history"\n'
  )
  // O spawn agora é login → estes carregam os reais (.zprofile traz o brew shellenv etc).
  writeFileSync(join(dir, '.zprofile'), '[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n')
  writeFileSync(join(dir, '.zlogin'), '[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n')
  zshShimDir = dir
  return dir
}

const zshAdapter: ShellAdapter = {
  id: 'zsh',
  match: (f) => basename(f).includes('zsh'),
  // -l (login) → o shim .zprofile/.zlogin carregam os reais do usuário (brew shellenv, PATH, etc).
  // -i (interactive) → garante o estágio do .zshrc mesmo se o tty não for autodetectado.
  plan: (ctx) => ({
    args: ['-l', '-i'],
    env: {
      ZDOTDIR: ensureZshShim(),
      HISTFILE: ctx.histfile,
      DECKY_HISTFILE: ctx.histfile
    }
  })
}

// ---------------------------------------------------------------------------------------------
// FALLBACK — qualquer shell sem adapter dedicado. Login+interativo: o PRÓPRIO shell carrega sua
// cadeia de init completa (.bash_profile/.profile/config.fish…), então config/PATH/brew funcionam
// shell-agnóstico. HISTFILE é setado pra isolar por aba nos shells que o respeitam (bash, sh, ksh);
// fish ignora (usa fish_history) — aceitável: o fallback prioriza "config funciona", não os extras.
// ---------------------------------------------------------------------------------------------
const fallbackAdapter: ShellAdapter = {
  id: 'fallback',
  match: () => true,
  plan: (ctx) => ({
    args: ['-l', '-i'],
    env: { HISTFILE: ctx.histfile, DECKY_HISTFILE: ctx.histfile }
  })
}

// Ordem importa: adapters específicos primeiro, fallback por último (match sempre true).
const ADAPTERS: ShellAdapter[] = [zshAdapter, fallbackAdapter]

function deckyHistfile(sessionId: string): string {
  const dir = join(os.homedir(), '.decky', 'histories')
  mkdirSync(dir, { recursive: true })
  return join(dir, sessionId)
}

// Resolve o plano de spawn (argv + env) pro shell dado. Tolerante a falha: se algo no adapter
// (mkdir/writeFile) explodir, cai num login-shell puro sem extras — melhor que derrubar o spawn.
export function planShellSpawn(shellFile: string, sessionId: string): ShellSpawnPlan {
  try {
    const ctx: ShellCtx = { sessionId, histfile: deckyHistfile(sessionId) }
    const adapter = ADAPTERS.find((a) => a.match(shellFile)) ?? fallbackAdapter
    return adapter.plan(ctx)
  } catch {
    return { args: ['-l', '-i'], env: {} }
  }
}

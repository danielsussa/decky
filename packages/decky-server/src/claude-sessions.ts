import { readdirSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Leitor das conversas que o claude-code guarda no disco. Cada sessão é um arquivo
// ~/.claude/projects/<slug>/<sessionId>.jsonl, onde <slug> é o cwd com `/` e `.` virando `-`
// (mesmo encoding do pty-manager). Daqui o decky monta: (1) o título real das abas abertas
// (aiTitle, em vez do placeholder aleatório) e (2) o picker de "sessões anteriores".

export interface ClaudeSessionInfo {
  /** sessionId = basename do .jsonl; é o que `claude --resume <id>` aceita. */
  id: string
  /** aiTitle — título auto-gerado pelo claude. null enquanto a conversa não recebeu um. */
  title: string | null
  /** branch git registrada na conversa (exibição/contexto). */
  gitBranch: string | null
  /** Primeiro prompt (best-effort) — fallback de exibição quando não há title. */
  lastPrompt: string | null
  /** mtime do arquivo (ordenação por recência). */
  mtimeMs: number
  /**
   * Timestamp do último turn REAL (user/assistant), não o mtime — alimenta o filtro de recência das
   * abas. O mtime mente: o decky bumpa o .jsonl ao re-abrir a conversa em background (live pool)
   * escrevendo metadado sem timestamp, então uma conversa ociosa há horas mas só resumida agora
   * teria mtime "agora". O último turn de verdade é o sinal honesto de "quando interagi com isto".
   * Fallback pro mtime quando nenhum turn é legível.
   */
  lastTurnMs: number
}

function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// session id do claude = UUID v4 (basename do .jsonl OU nome da pasta `<sid>/`). Distingue a pasta
// `memory/` (e afins) de uma sessão ao varrer o dir do projeto.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Lê só um prefixo do .jsonl (título/branch aparecem nos primeiros records; evita carregar
// transcripts de vários MB). Extrai por regex pra não depender de linhas JSON completas.
function readHeadFields(
  file: string
): Pick<ClaudeSessionInfo, 'title' | 'gitBranch' | 'lastPrompt'> {
  let txt = ''
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(262144) // 256KB — folga p/ mensagens com imagem inline (base64) no topo
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    txt = buf.toString('utf8', 0, n)
  } catch {
    return { title: null, gitBranch: null, lastPrompt: null }
  }
  const grab = (key: string): string | null => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(txt)
    if (!m) return null
    try {
      return JSON.parse(`"${m[1]}"`) as string // des-escapa \uXXXX, \", etc.
    } catch {
      return m[1]
    }
  }
  return { title: grab('aiTitle'), gitBranch: grab('gitBranch'), lastPrompt: firstUserPrompt(txt) }
}

// 1º prompt de verdade do usuário — rótulo de fallback pras conversas SEM aiTitle no picker (em vez
// do hash do id). O claude NÃO grava um campo "lastPrompt": o texto vive em records type:"user"
// cujo message.content é string OU array de blocos {type:"text"}. Por isso não dá pra pegar por
// regex simples como aiTitle — varre o head linha a linha. Pula meta/caveat (isMeta), records sem
// bloco de texto (tool_result/image) e wrappers de slash-command (<command-name>…/<local-command-…>).
function firstUserPrompt(txt: string): string | null {
  for (const line of txt.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    // Pré-filtro barato: só registros de mensagem do usuário, nunca os meta/caveat (a linha
    // "[Image: source: …]" e a do caveat vêm com "isMeta":true).
    if (!s.includes('"type":"user"') || s.includes('"isMeta":true')) continue
    let text: string | null = null
    try {
      const content = (JSON.parse(s) as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        for (const b of content) {
          const blk = b as { type?: unknown; text?: unknown }
          if (blk?.type === 'text' && typeof blk.text === 'string') {
            text = blk.text
            break
          }
        }
      }
    } catch {
      // Linha gigante cortada pelo limite do head: mensagem com imagem inline em base64. O bloco de
      // texto vem ANTES do de imagem no content, então o prefixo já o contém — extrai o 1º
      // "text":"…" (form array) ou o "content":"…" (form string) por regex tolerante a truncação.
      const m = /"text":"((?:[^"\\]|\\.)*)"/.exec(s) ?? /"content":"((?:[^"\\]|\\.)*)"/.exec(s)
      if (m) {
        try {
          text = JSON.parse(`"${m[1]}"`) as string
        } catch {
          text = m[1]
        }
      }
    }
    if (!text) continue
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || clean.startsWith('<')) continue // wrapper de comando, não prompt humano
    return clean.length > 100 ? clean.slice(0, 99) + '…' : clean
  }
  return null
}

/**
 * Lista as conversas do claude guardadas pra ESTE cwd, da mais recente pra mais antiga.
 * Retorna `[]` se a pasta não existe (claude nunca rodou neste cwd).
 */
export function listClaudeSessions(cwd: string): ClaudeSessionInfo[] {
  const dir = join(homedir(), '.claude', 'projects', projectSlug(cwd))
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Uma sessão é `<sid>.jsonl` (transcript) OU uma pasta `<sid>/` (claude-code 2.x: criada quando o
  // 1º turno dispara subagents, ANTES do .jsonl principal flushar). Dedup por sid — quando as duas
  // formas coexistem o .jsonl manda (head fields/aiTitle); pasta-só → title/branch null até flushar.
  const seen = new Set<string>()
  const rows: ClaudeSessionInfo[] = []
  for (const e of entries) {
    let sid: string | null = null
    if (e.isFile() && e.name.endsWith('.jsonl')) sid = e.name.slice(0, -'.jsonl'.length)
    else if (e.isDirectory() && SESSION_ID_RE.test(e.name)) sid = e.name
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    const full = join(dir, `${sid}.jsonl`)
    let mtimeMs = 0
    let head = { title: null, gitBranch: null, lastPrompt: null } as ReturnType<typeof readHeadFields>
    let lastTurnMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
      head = readHeadFields(full)
      // lastTurnMs = último turn real (não o mtime ruidoso de resume). Fallback pro mtime quando o
      // tail não tem turn legível (conversa só com metadado / formato inesperado).
      lastTurnMs = lastTurnTime(full) || mtimeMs
    } catch {
      // pasta-só (sem .jsonl ainda): ordena pela mtime da pasta, sem head fields.
      try {
        mtimeMs = statSync(join(dir, sid)).mtimeMs
        lastTurnMs = mtimeMs
      } catch {
        continue
      }
    }
    rows.push({ id: sid, mtimeMs, lastTurnMs, ...head })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows
}

// Tail lido pra achar o último turn real (128KB cobre vários turns recentes sem ler transcripts
// de MBs). Turns são frequentes o bastante pra caberem nessa janela.
const TURN_TAIL_BYTES = 131072

// Maior timestamp de um turn REAL de conversa (records type:"user"/"assistant" carregam
// "timestamp":"<iso>"). NÃO conta os records de metadado que o decky/claude escrevem em background
// no resume (permission-mode, mode, ai-title, last-prompt) — esses não têm timestamp — nem os
// records type:"system", que o resume pode injetar com a hora atual sem o usuário ter feito nada.
// É isto que separa "workspace ativo" de "workspace só re-aberto". Lê só o tail. 0 se não achar.
function lastTurnTime(file: string): number {
  let txt = ''
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - TURN_TAIL_BYTES)
    const len = size - start
    if (len <= 0) return 0
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, start)
    } finally {
      closeSync(fd)
    }
    txt = buf.toString('utf8')
  } catch {
    return 0
  }
  let max = 0
  // 1 record por linha; a 1ª pode vir truncada pelo offset — só ignora (regex não casa).
  for (const line of txt.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    const m = /"timestamp":"([^"]+)"/.exec(line)
    if (!m) continue
    const t = Date.parse(m[1])
    if (t > max) max = t
  }
  return max
}

/** Caminho do .jsonl da conversa do claude pra este cwd + sessionId. */
export function claudeSessionFile(cwd: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectSlug(cwd), `${claudeSessionId}.jsonl`)
}

/**
 * Apaga DEFINITIVAMENTE o .jsonl da conversa do claude (cwd + sessionId). Usado pelo "x" do picker
 * de "sessões anteriores": some da lista E remove a conversa do disco (não dá mais pra `--resume`).
 * Idempotente: se o arquivo já não existe, retorna sem erro.
 */
export function deleteClaudeSession(cwd: string, claudeSessionId: string): void {
  try {
    unlinkSync(claudeSessionFile(cwd, claudeSessionId))
  } catch {
    // já apagado / nunca existiu — nada a fazer
  }
}

// Lê o ÚLTIMO aiTitle do arquivo. O título evolui com a conversa (o claude regenera) — pro sync
// contínuo queremos o ATUAL, não o primeiro. Lê só o TAIL: o aiTitle é carimbado nos records
// recentes, então isto é barato e robusto a transcripts de vários MB, ao contrário do
// readHeadFields (head-only + first-match). null enquanto a conversa não recebeu título.
const AI_TITLE_TAIL_BYTES = 65536
export function readLatestAiTitle(file: string): string | null {
  let fd: number | undefined
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - AI_TITLE_TAIL_BYTES)
    const len = size - start
    if (len <= 0) return null
    const buf = Buffer.alloc(len)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, len, start)
    // O offset pode cair no meio de um char/linha: só o 1º record fica truncado; os matches de
    // aiTitle que queremos vêm completos depois. Pega o ÚLTIMO match.
    const txt = buf.toString('utf8')
    const re = /"aiTitle":"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    let last: string | null = null
    while ((m = re.exec(txt)) !== null) last = m[1]
    if (last == null) return null
    try {
      return JSON.parse(`"${last}"`) as string // des-escapa \uXXXX, \", etc.
    } catch {
      return last
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

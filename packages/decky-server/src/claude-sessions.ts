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
}

function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// Lê só um prefixo do .jsonl (título/branch aparecem nos primeiros records; evita carregar
// transcripts de vários MB). Extrai por regex pra não depender de linhas JSON completas.
function readHeadFields(file: string): Pick<ClaudeSessionInfo, 'title' | 'gitBranch' | 'lastPrompt'> {
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
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const rows: ClaudeSessionInfo[] = []
  for (const f of files) {
    const full = join(dir, f)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      continue
    }
    const head = readHeadFields(full)
    rows.push({ id: f.slice(0, -'.jsonl'.length), mtimeMs, ...head })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows
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

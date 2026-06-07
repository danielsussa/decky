import { t } from '../lib/i18n'

interface DiffPreviewProps {
  content: string
}

type RowKind = 'add' | 'del' | 'ctx' | 'hunk'
interface Row {
  kind: RowKind
  oldNo?: number
  newNo?: number
  text: string
}
interface FileDiff {
  path: string
  adds: number
  dels: number
  rows: Row[]
}

// Parse a unified diff (git diff / diff -u). Tolerant of bare diffs without a `diff --git`
// header — keys off the @@ hunk headers and +/-/space line prefixes.
function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let oldNo = 0
  let newNo = 0
  const open = (path: string): FileDiff => {
    const f: FileDiff = { path, adds: 0, dels: 0, rows: [] }
    files.push(f)
    return f
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      cur = open(m ? m[2] : line.replace(/^diff --git\s*/, ''))
      continue
    }
    if (
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('Binary files')
    ) {
      if (!cur && line.startsWith('+++ ')) cur = open(line.slice(4).replace(/^b\//, '').trim())
      continue
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
      }
      if (!cur) cur = open('')
      cur.rows.push({ kind: 'hunk', text: m ? (m[3]?.trim() ?? '') : line })
      continue
    }
    if (!cur) continue
    const c = line[0]
    if (c === '+') {
      cur.rows.push({ kind: 'add', newNo, text: line.slice(1) })
      newNo++
      cur.adds++
    } else if (c === '-') {
      cur.rows.push({ kind: 'del', oldNo, text: line.slice(1) })
      oldNo++
      cur.dels++
    } else if (c === '\\') {
      // "\ No newline at end of file" — ignore
    } else {
      cur.rows.push({ kind: 'ctx', oldNo, newNo, text: line.slice(1) })
      oldNo++
      newNo++
    }
  }
  return files
}

const sign = (k: RowKind): string => (k === 'add' ? '+' : k === 'del' ? '-' : '')

export default function DiffPreview({ content }: DiffPreviewProps): React.JSX.Element {
  const files = parseDiff(content)
  if (files.length === 0) {
    return (
      <div className="panel-placeholder">
        <p className="muted">{t('diff.empty')}</p>
      </div>
    )
  }
  return (
    <div className="diff-preview">
      {files.map((f, i) => (
        <div className="diff-file" key={`${f.path}-${i}`}>
          <div className="diff-file-header">
            <span className="diff-file-path">{f.path || 'diff'}</span>
            <span className="diff-stat">
              <span className="diff-stat-add">+{f.adds}</span>
              <span className="diff-stat-del">−{f.dels}</span>
            </span>
          </div>
          <table className="diff-table">
            <tbody>
              {f.rows.map((r, j) => (
                <tr key={j} className={`diff-row diff-${r.kind}`}>
                  <td className="diff-ln">{r.kind === 'hunk' ? '' : (r.oldNo ?? '')}</td>
                  <td className="diff-ln">{r.kind === 'hunk' ? '' : (r.newNo ?? '')}</td>
                  <td className="diff-sign">{sign(r.kind)}</td>
                  <td className="diff-code">
                    {r.kind === 'hunk' ? (
                      <span className="diff-hunk-label">{r.text || '⋯'}</span>
                    ) : (
                      r.text || ' '
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

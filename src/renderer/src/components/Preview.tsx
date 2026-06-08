import MePreview from './MePreview'
import MarkdownPreview from './MarkdownPreview'
import JsonPreview from './JsonPreview'
import WebPreview from './WebPreview'
import DiffPreview from './DiffPreview'
import EditorPreview from './EditorPreview'
import XlsxPreview from './XlsxPreview'
import FormPreview from './FormPreview'
import type { PreviewSource } from '../../../shared/preview'

interface PreviewProps {
  source: PreviewSource
  cardId?: string
  sessionId?: string
  // Cwd of the session this preview belongs to. Threaded into web cards so main can tag
  // history visits with the right workspace.
  workspaceCwd?: string | null
  onWebMetaChange?: (meta: { url?: string; title?: string; favicon?: string | null }) => void
}

export default function Preview({
  source,
  cardId,
  sessionId,
  workspaceCwd,
  onWebMetaChange
}: PreviewProps): React.JSX.Element {
  if (source.type === 'me') return <MePreview url={source.url} />
  if (source.type === 'markdown')
    return (
      <MarkdownPreview
        content={source.content}
        cardId={cardId}
        sessionId={sessionId}
        path={source.path}
      />
    )
  if (source.type === 'json') return <JsonPreview value={source.value} />
  if (source.type === 'web') {
    // cardId is required for WebContentsView routing — a web card without one wouldn't have
    // a stable handle for main to address. In practice every web card is created with one
    // (see App.tsx panel/session card construction). Show an empty fallback if it ever isn't.
    if (!cardId) return <div className="preview-empty"><p>card sem id — recrie a aba</p></div>
    return (
      <WebPreview
        cardId={cardId}
        url={source.url}
        workspaceCwd={workspaceCwd ?? null}
        onMetaChange={onWebMetaChange}
      />
    )
  }
  if (source.type === 'diff') return <DiffPreview content={source.content} />
  if (source.type === 'editor') return <EditorPreview content={source.content} path={source.path} />
  if (source.type === 'xlsx') return <XlsxPreview path={source.path} />
  if (source.type === 'form') return <FormPreview key={source.spec.formId} spec={source.spec} />

  return (
    <div className="preview-empty">
      <p>
        nada pra mostrar. use <code>dky show &lt;arquivo&gt;</code> ou <code>dky show --me</code> no
        terminal.
      </p>
    </div>
  )
}

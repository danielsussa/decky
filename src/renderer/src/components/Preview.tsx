import MePreview from './MePreview'
import MarkdownPreview from './MarkdownPreview'
import JsonPreview from './JsonPreview'
import WebPreview from './WebPreview'
import DiffPreview from './DiffPreview'
import EditorPreview from './EditorPreview'
import XlsxPreview from './XlsxPreview'
import type { PreviewSource } from '../../../shared/preview'

interface PreviewProps {
  source: PreviewSource
  cardId?: string
}

export default function Preview({ source, cardId }: PreviewProps): React.JSX.Element {
  if (source.type === 'me') return <MePreview url={source.url} />
  if (source.type === 'markdown')
    return <MarkdownPreview content={source.content} cardId={cardId} />
  if (source.type === 'json') return <JsonPreview value={source.value} />
  if (source.type === 'web') return <WebPreview url={source.url} />
  if (source.type === 'diff') return <DiffPreview content={source.content} />
  if (source.type === 'editor') return <EditorPreview content={source.content} path={source.path} />
  if (source.type === 'xlsx') return <XlsxPreview path={source.path} />

  return (
    <div className="preview-empty">
      <p>
        nada pra mostrar. use <code>dky show &lt;arquivo&gt;</code> ou <code>dky show --me</code> no
        terminal.
      </p>
    </div>
  )
}

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
  onWebUrlChange?: (url: string) => void
}

export default function Preview({
  source,
  cardId,
  onWebUrlChange
}: PreviewProps): React.JSX.Element {
  if (source.type === 'me') return <MePreview url={source.url} />
  if (source.type === 'markdown')
    return <MarkdownPreview content={source.content} cardId={cardId} path={source.path} />
  if (source.type === 'json') return <JsonPreview value={source.value} />
  if (source.type === 'web') return <WebPreview url={source.url} onUrlChange={onWebUrlChange} />
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

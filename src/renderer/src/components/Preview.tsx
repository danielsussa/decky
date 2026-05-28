import MePreview from './MePreview'
import MarkdownPreview from './MarkdownPreview'
import JsonPreview from './JsonPreview'
import WebPreview from './WebPreview'
import type { PreviewSource } from '../../../shared/preview'

interface PreviewProps {
  source: PreviewSource
}

export default function Preview({ source }: PreviewProps): React.JSX.Element {
  if (source.type === 'me') return <MePreview url={source.url} />
  if (source.type === 'markdown') return <MarkdownPreview content={source.content} />
  if (source.type === 'json') return <JsonPreview value={source.value} />
  if (source.type === 'web') return <WebPreview url={source.url} />

  return (
    <div className="preview-empty">
      <p>
        nada pra mostrar. use <code>dky show &lt;arquivo&gt;</code> ou <code>dky show --me</code> no
        terminal.
      </p>
    </div>
  )
}

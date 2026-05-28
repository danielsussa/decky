import MePreview from './MePreview'
import MarkdownPreview from './MarkdownPreview'
import JsonPreview from './JsonPreview'
import type { PreviewSource } from '../../../shared/preview'

interface PreviewProps {
  source: PreviewSource
}

export default function Preview({ source }: PreviewProps): React.JSX.Element {
  if (source.type === 'me') return <MePreview url={source.url} />
  if (source.type === 'markdown')
    return <MarkdownPreview content={source.content} title={source.title} />
  if (source.type === 'json') return <JsonPreview value={source.value} />

  return (
    <div className="preview-empty">
      <p>
        nada pra mostrar. use <code>dk show &lt;arquivo&gt;</code> ou{' '}
        <code>dk show --me</code> no terminal.
      </p>
    </div>
  )
}

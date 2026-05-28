import { useEffect, useState } from 'react'
import MePreview from './MePreview'
import MarkdownPreview from './MarkdownPreview'
import JsonPreview from './JsonPreview'
import type { PreviewSource } from '../../../shared/preview'

export default function Preview(): React.JSX.Element {
  const [source, setSource] = useState<PreviewSource>({ type: 'none' })

  useEffect(() => {
    void window.deck.preview.getCurrent().then(setSource)
    return window.deck.preview.onSourceChange(setSource)
  }, [])

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

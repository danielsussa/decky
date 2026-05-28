import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

interface MarkdownPreviewProps {
  content: string
  title?: string
}

export default function MarkdownPreview({ content, title }: MarkdownPreviewProps): React.JSX.Element {
  return (
    <div className="md-preview">
      {title && <div className="md-title">{title}</div>}
      <div className="md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

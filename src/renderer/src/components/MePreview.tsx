import { useState } from 'react'

const DEFAULT_URL = 'http://127.0.0.1:6789'

interface MePreviewProps {
  url?: string
}

export default function MePreview({ url }: MePreviewProps): React.JSX.Element {
  const [override, setOverride] = useState(url ?? DEFAULT_URL)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <div className="me-preview">
      <div className="preview-toolbar">
        <input
          className="url-input"
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          spellCheck={false}
        />
        <button
          className="icon-btn"
          title="recarregar"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          ↻
        </button>
      </div>
      <iframe
        key={reloadKey}
        className="liveview-frame"
        src={override}
        title="me live view"
      />
    </div>
  )
}

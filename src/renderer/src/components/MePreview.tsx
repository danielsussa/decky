import { useEffect, useState } from 'react'

const BASE = 'http://127.0.0.1:6789'

interface MePreviewProps {
  url?: string
}

export default function MePreview({ url }: MePreviewProps): React.JSX.Element {
  const [daemonUp, setDaemonUp] = useState<boolean | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    const ping = async (): Promise<void> => {
      try {
        await fetch(`${BASE}/api/tabs`)
        if (active) setDaemonUp(true)
      } catch {
        if (active) setDaemonUp(false)
      }
    }
    void ping()
    const iv = setInterval(ping, 3000)
    return () => {
      active = false
      clearInterval(iv)
    }
  }, [reloadKey])

  if (daemonUp === false) {
    return (
      <div className="preview-empty">
        <p>
          o <strong>me daemon</strong> não está rodando (sem servidor em <code>127.0.0.1:6789</code>
          ).
          <br />
          rode <code>handoff start</code> num terminal e clique recarregar.
        </p>
        <button className="sstack-add-btn primary" onClick={() => setReloadKey((k) => k + 1)}>
          recarregar
        </button>
      </div>
    )
  }

  return (
    <div className="me-preview">
      <iframe className="liveview-frame" src={url ?? BASE} title="me live view" />
    </div>
  )
}

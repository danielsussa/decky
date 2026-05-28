import { useEffect, useState } from 'react'

const BASE = 'http://127.0.0.1:6789'

interface MePreviewProps {
  url?: string
}

function tabFromUrl(url?: string): string | null {
  if (!url) return null
  const m = url.match(/\/tab\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export default function MePreview({ url }: MePreviewProps): React.JSX.Element {
  const [tabs, setTabs] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(() => tabFromUrl(url))
  const [daemonUp, setDaemonUp] = useState<boolean | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const t = tabFromUrl(url)
    if (t) setSelected(t)
  }, [url])

  useEffect(() => {
    let active = true
    const fetchTabs = async (): Promise<void> => {
      try {
        const res = await fetch(`${BASE}/api/tabs`)
        const list = (await res.json()) as unknown
        if (!active) return
        setDaemonUp(true)
        if (Array.isArray(list)) {
          setTabs(list as string[])
          setSelected((cur) => cur ?? (list as string[])[0] ?? null)
        }
      } catch {
        if (active) setDaemonUp(false)
      }
    }
    void fetchTabs()
    const iv = setInterval(fetchTabs, 3000)
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

  const iframeSrc = selected ? `${BASE}/tab/${encodeURIComponent(selected)}` : (url ?? BASE)

  return (
    <div className="me-preview">
      <div className="me-preview-bar">
        <select
          className="me-tab-select"
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {tabs.length === 0 && <option value="">(sem abas)</option>}
          {tabs.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <iframe className="liveview-frame" src={iframeSrc} title="me live view" />
    </div>
  )
}

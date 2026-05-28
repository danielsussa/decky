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

  // If the caller passes a specific tab URL, follow it.
  useEffect(() => {
    const t = tabFromUrl(url)
    if (t) setSelected(t)
  }, [url])

  // Poll the daemon for the live tab list (picks up popup-N as OAuth/popups appear).
  useEffect(() => {
    let active = true
    const fetchTabs = async (): Promise<void> => {
      try {
        const res = await fetch(`${BASE}/api/tabs`)
        const list = (await res.json()) as unknown
        if (active && Array.isArray(list)) {
          setTabs(list as string[])
          setSelected((cur) => cur ?? (list as string[])[0] ?? null)
        }
      } catch {
        // daemon down — leave tabs as-is
      }
    }
    void fetchTabs()
    const iv = setInterval(fetchTabs, 3000)
    return () => {
      active = false
      clearInterval(iv)
    }
  }, [])

  const iframeSrc = selected ? `${BASE}/tab/${encodeURIComponent(selected)}` : url ?? BASE

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

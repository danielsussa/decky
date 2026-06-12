import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from '../lib/i18n'

export interface WorkspacePage {
  id: string
  path: string
  title: string
  mtime: number
  tags?: string[]
}

interface PagesPanelProps {
  workspace: string | null
  onOpen: (page: WorkspacePage) => void
  onDelete: (page: WorkspacePage) => Promise<boolean>
}

function formatMtime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return 'agora'
  if (diff < hour) return `${Math.round(diff / min)}m atrás`
  if (diff < day) return `${Math.round(diff / hour)}h atrás`
  if (diff < 30 * day) return `${Math.round(diff / day)}d atrás`
  return new Date(ms).toLocaleDateString()
}

export default function PagesPanel({
  workspace,
  onOpen,
  onDelete
}: PagesPanelProps): React.JSX.Element {
  const [pages, setPages] = useState<WorkspacePage[] | null>(null)
  const [q, setQ] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Bumped by the refresh button (and after a delete) to re-run the load effect.
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    void window.deck.cards.list(workspace).then((list) => {
      if (!cancelled) setPages(list)
    })
    return () => {
      cancelled = true
    }
  }, [workspace, reloadTick])

  const reload = useCallback((): void => setReloadTick((t) => t + 1), [])

  const filtered = useMemo(() => {
    if (!pages) return null
    const needle = q.toLowerCase().trim()
    if (!needle) return pages
    // `#tag` tokens AND with the bare-word part.
    const requiredTags = (needle.match(/#([a-z0-9][a-z0-9_-]*)/g) || []).map((s) => s.slice(1))
    const bare = needle.replace(/#[a-z0-9][a-z0-9_-]*/g, '').trim()
    return pages.filter((p) => {
      if (requiredTags.length) {
        const tags = p.tags ?? []
        if (!requiredTags.every((t) => tags.includes(t))) return false
      }
      if (!bare) return true
      const tagText = (p.tags ?? []).join(' ')
      return `${p.title} ${p.id} ${p.path} ${tagText}`.toLowerCase().includes(bare)
    })
  }, [pages, q])

  const handleDelete = async (page: WorkspacePage): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await onDelete(page)
      if (ok) {
        setPages((prev) => (prev ? prev.filter((p) => p.path !== page.path) : prev))
      }
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

  if (!workspace) {
    return (
      <div className="pages-panel">
        <div className="pages-empty">Nenhum workspace aberto.</div>
      </div>
    )
  }

  return (
    <div className="pages-panel">
      <div className="pages-toolbar">
        <input
          className="pages-search"
          placeholder={t('pages.filterPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button className="pages-refresh" type="button" onClick={reload} title={t('common.reload')}>
          ↻
        </button>
      </div>
      {filtered === null ? (
        <div className="pages-empty">{t('pages.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="pages-empty">
          {pages && pages.length === 0 ? t('pages.empty') : t('pages.emptyFilter')}
        </div>
      ) : (
        <ul className="pages-list">
          {filtered.map((p) => {
            const confirming = pendingDelete === p.path
            return (
              <li key={p.path} className="pages-row">
                <button
                  type="button"
                  className="pages-row-main"
                  onClick={() => onOpen(p)}
                  title={p.path}
                >
                  <span className="pages-title">{p.title}</span>
                  {p.tags && p.tags.length > 0 && (
                    <span className="pages-tags">
                      {p.tags.map((tag) => (
                        <span
                          key={tag}
                          className="card-tag-chip"
                          onClick={(e) => {
                            e.stopPropagation()
                            setQ(`#${tag}`)
                          }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="pages-meta">
                    <span className="pages-id">{p.id}</span>
                    {p.mtime > 0 && <span className="pages-mtime">{formatMtime(p.mtime)}</span>}
                  </span>
                </button>
                <div className="pages-actions">
                  <button type="button" className="pages-btn" onClick={() => onOpen(p)}>
                    {t('common.open')}
                  </button>
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        className="pages-btn pages-btn-danger"
                        onClick={() => void handleDelete(p)}
                        disabled={busy}
                      >
                        {t('common.confirm')}
                      </button>
                      <button
                        type="button"
                        className="pages-btn"
                        onClick={() => setPendingDelete(null)}
                        disabled={busy}
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="pages-btn pages-btn-danger-outline"
                      onClick={() => setPendingDelete(p.path)}
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

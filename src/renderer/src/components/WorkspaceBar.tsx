import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderPlus, Check } from 'lucide-react'

interface WorkspaceBarProps {
  current: string | null
  workspaces: string[]
  onSwitch: (path: string) => void
  onAddFolder: () => void
  nameOf: (path: string) => string
}

export default function WorkspaceBar({
  current,
  workspaces,
  onSwitch,
  onAddFolder,
  nameOf
}: WorkspaceBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div className="wsbar" ref={ref}>
      <button type="button" className="wsbar-current" onClick={() => setOpen((v) => !v)}>
        <span className="wsbar-name">{current ? nameOf(current) : 'sem workspace'}</span>
        <ChevronDown size={14} className="wsbar-caret" />
      </button>
      {open && (
        <div className="wsbar-menu">
          {workspaces.map((ws) => (
            <button
              type="button"
              key={ws}
              className={`wsbar-item ${ws === current ? 'wsbar-item-active' : ''}`}
              title={ws}
              onClick={() => {
                setOpen(false)
                if (ws !== current) onSwitch(ws)
              }}
            >
              <span className="wsbar-check">{ws === current ? <Check size={13} /> : null}</span>
              <span className="wsbar-item-name">{nameOf(ws)}</span>
            </button>
          ))}
          {workspaces.length > 0 && <div className="wsbar-sep" />}
          <button
            type="button"
            className="wsbar-item wsbar-add"
            onClick={() => {
              setOpen(false)
              onAddFolder()
            }}
          >
            <FolderPlus size={13} />
            <span>Adicionar pasta…</span>
          </button>
        </div>
      )}
    </div>
  )
}

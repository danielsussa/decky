import { FolderPlus, Check } from 'lucide-react'

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
  return (
    <div className="wsbar">
      <div className="wsbar-title">workspaces</div>
      <div className="wsbar-list">
        {workspaces.map((ws) => (
          <button
            type="button"
            key={ws}
            className={`wsbar-item ${ws === current ? 'wsbar-item-active' : ''}`}
            title={ws}
            onClick={() => {
              if (ws !== current) onSwitch(ws)
            }}
          >
            <span className="wsbar-check">{ws === current ? <Check size={13} /> : null}</span>
            <span className="wsbar-item-name">{nameOf(ws)}</span>
          </button>
        ))}
        <button type="button" className="wsbar-item wsbar-add" onClick={onAddFolder}>
          <FolderPlus size={13} />
          <span>Adicionar pasta…</span>
        </button>
      </div>
    </div>
  )
}

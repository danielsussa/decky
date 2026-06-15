import { useEffect } from 'react'
import { FolderPlus, Monitor, Server, X } from 'lucide-react'
import type { Engine } from '@decky/shared'
import { t } from '../lib/i18n'

interface EnginePickerModalProps {
  engines: Engine[]
  onDismiss: () => void
  onPick: (engineId: string) => void
}

// Modal pequeno mostrado quando o user clica "+ Add folder" e há 2+ engines (local + servers).
// Lista cada engine como uma row clicável. Click vai pro próximo passo: dialog nativo se local,
// modal de input path se remoto.
export default function EnginePickerModal({
  engines,
  onDismiss,
  onPick
}: EnginePickerModalProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div className="add-server-modal-backdrop" onClick={onDismiss}>
      <div
        className="add-server-modal add-server-modal-narrow"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-server-modal-header">
          <div className="add-server-modal-title">
            <FolderPlus size={18} />
            <span>{t('addFolder.engineTitle')}</span>
          </div>
          <button
            type="button"
            className="add-server-modal-close"
            onClick={onDismiss}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">{t('addFolder.engineSubtitle')}</p>

        <ul className="engine-picker-list">
          {engines.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="engine-picker-row"
                onClick={() => onPick(e.id)}
              >
                <span className="engine-picker-icon">
                  {e.kind === 'local' ? <Monitor size={16} /> : <Server size={16} />}
                </span>
                <span className="engine-picker-label">
                  <span className="engine-picker-name">{e.label}</span>
                  <span className="engine-picker-detail">
                    {e.kind === 'local' ? t('addFolder.localDetail') : e.sshHost || e.url}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

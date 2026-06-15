import { useEffect } from 'react'
import { AlertCircle, Server, X } from 'lucide-react'
import type { Engine } from '@decky/shared'
import { t } from '../lib/i18n'

interface ConfirmEngineRemoveModalProps {
  engine: Engine
  affectedWorkspaces: string[]
  onCancel: () => void
  onConfirm: () => void
}

// Modal de confirmação ao clicar no X de um engine remoto. Mostra qual host é + lista os
// workspaces que vão sumir da árvore (os dados no host remoto FICAM intactos — só desconecta).
export default function ConfirmEngineRemoveModal({
  engine,
  affectedWorkspaces,
  onCancel,
  onConfirm
}: ConfirmEngineRemoveModalProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="add-server-modal-backdrop" onClick={onCancel}>
      <div
        className="add-server-modal add-server-modal-narrow"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-server-modal-header">
          <div className="add-server-modal-title">
            <Server size={18} />
            <span>{t('engineRemove.title')}</span>
          </div>
          <button
            type="button"
            className="add-server-modal-close"
            onClick={onCancel}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">
          {t('engineRemove.subtitle').replace('{label}', engine.label)}
        </p>

        <div className="confirm-engine-remove-body">
          <div className="confirm-engine-remove-info">
            <AlertCircle size={14} />
            <span>{t('engineRemove.disclaimer')}</span>
          </div>

          {affectedWorkspaces.length > 0 && (
            <div className="confirm-engine-remove-section">
              <div className="confirm-engine-remove-section-title">
                {t('engineRemove.workspacesAffected').replace(
                  '{n}',
                  String(affectedWorkspaces.length)
                )}
              </div>
              <ul className="confirm-engine-remove-list">
                {affectedWorkspaces.map((p) => (
                  <li key={p} className="confirm-engine-remove-item">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="add-server-modal-actions">
          <button type="button" className="add-server-modal-cancel" onClick={onCancel}>
            {t('server.cancel')}
          </button>
          <button
            type="button"
            className="add-server-modal-connect add-server-modal-danger"
            onClick={onConfirm}
          >
            {t('engineRemove.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

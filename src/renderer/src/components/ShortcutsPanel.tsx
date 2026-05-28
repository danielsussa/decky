import { useEffect, useState } from 'react'
import {
  ACTIONS,
  accelLabel,
  conflictFor,
  eventToAccel,
  type ActionId
} from '../../../shared/keymap'

interface ShortcutsPanelProps {
  resolved: Record<ActionId, string>
  onSet: (id: ActionId, accel: string) => void
  onReset: (id: ActionId) => void
  /** Reports whether we're currently capturing a chord, so the global handler can stand down. */
  onCapturingChange?: (active: boolean) => void
}

export default function ShortcutsPanel({
  resolved,
  onSet,
  onReset,
  onCapturingChange
}: ShortcutsPanelProps): React.JSX.Element {
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onCapturingChange?.(recording !== null)
  }, [recording, onCapturingChange])

  // Release the capture lock if the tab unmounts mid-recording.
  useEffect(() => () => onCapturingChange?.(false), [onCapturingChange])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }
      const accel = eventToAccel(e)
      if (!accel) {
        setError('use ao menos um modificador (Cmd / Ctrl / Alt)')
        return
      }
      const clash = conflictFor(resolved, accel, recording)
      if (clash) {
        const label = ACTIONS.find((a) => a.id === clash)?.label ?? clash
        setError(`${accelLabel(accel)} já está em "${label}"`)
        return
      }
      onSet(recording, accel)
      setRecording(null)
      setError(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [recording, resolved, onSet])

  return (
    <div className="shortcuts-panel">
      <div className="remap-section">Atalhos de teclado</div>
      <div className="remap-rows">
        {ACTIONS.map((a) => {
          const isRec = recording === a.id
          return (
            <div key={a.id} className="remap-row">
              <span className="remap-label">{a.label}</span>
              <button
                type="button"
                className={`remap-chip ${isRec ? 'remap-chip-recording' : ''}`}
                onClick={() => {
                  setError(null)
                  setRecording(isRec ? null : a.id)
                }}
                title="clique e pressione o novo atalho"
              >
                {isRec ? 'pressione…' : accelLabel(resolved[a.id])}
              </button>
              <button
                type="button"
                className="remap-reset"
                onClick={() => {
                  setRecording(null)
                  setError(null)
                  onReset(a.id)
                }}
                title="restaurar padrão"
              >
                ↺
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="remap-error">{error}</div>}
      <div className="remap-hint">
        clique num atalho e pressione a nova combinação · Esc cancela
      </div>
    </div>
  )
}

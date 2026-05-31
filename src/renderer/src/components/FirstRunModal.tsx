import { useState } from 'react'
import {
  CLI_KINDS,
  CLI_SPECS,
  type CliKind,
  type DetectedCli
} from '../../../shared/cli-spec'

interface FirstRunModalProps {
  detectedClis: DetectedCli[]
  currentDefault: CliKind | null
  onSave: (kind: CliKind) => void | Promise<void>
  onSkip: () => void | Promise<void>
  onRecheck: () => Promise<DetectedCli[]>
}

export default function FirstRunModal({
  detectedClis,
  currentDefault,
  onSave,
  onSkip,
  onRecheck
}: FirstRunModalProps): React.JSX.Element {
  const initial: CliKind | null =
    currentDefault ?? detectedClis[0]?.kind ?? null
  const [selected, setSelected] = useState<CliKind | null>(initial)
  const [rechecking, setRechecking] = useState(false)

  const isEmpty = detectedClis.length === 0

  const handleRecheck = async (): Promise<void> => {
    setRechecking(true)
    try {
      const fresh = await onRecheck()
      if (!selected && fresh.length > 0) setSelected(fresh[0].kind)
    } finally {
      setRechecking(false)
    }
  }

  return (
    <div
      className="first-run-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) void onSkip()
      }}
    >
      <div className="first-run-modal" role="dialog" aria-modal="true">
        <div className="first-run-modal-header">
          <h2>
            {isEmpty ? 'Nenhum CLI de IA encontrado' : 'Escolha seu CLI de IA padrão'}
          </h2>
          <p className="first-run-modal-sub">
            {isEmpty
              ? 'Instale um destes e clique em "verificar". Você pode pular e instalar depois.'
              : 'Esse será o CLI usado em sessões novas. Você pode trocar depois.'}
          </p>
        </div>

        {isEmpty ? (
          <div className="first-run-modal-hints">
            {CLI_KINDS.map((kind) => {
              const spec = CLI_SPECS[kind]
              return (
                <div key={kind} className="first-run-modal-hint">
                  <span className="first-run-modal-hint-name">{spec.displayName}</span>
                  <code>{spec.installHint}</code>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="first-run-modal-options">
            {detectedClis.map((c) => (
              <label key={c.kind} className="first-run-modal-option">
                <input
                  type="radio"
                  name="default-cli"
                  value={c.kind}
                  checked={selected === c.kind}
                  onChange={() => setSelected(c.kind)}
                />
                <span className="first-run-modal-option-name">{c.displayName}</span>
                {c.version && (
                  <span className="first-run-modal-option-ver">{c.version}</span>
                )}
              </label>
            ))}
          </div>
        )}

        <div className="first-run-modal-footer">
          <button
            type="button"
            className="first-run-modal-skip"
            onClick={() => void onSkip()}
          >
            pular
          </button>
          {isEmpty ? (
            <button
              type="button"
              className="first-run-modal-action"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? 'verificando…' : 'já instalei, verificar'}
            </button>
          ) : (
            <button
              type="button"
              className="first-run-modal-action"
              disabled={!selected}
              onClick={() => selected && void onSave(selected)}
            >
              usar como padrão
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { CLI_KINDS, CLI_SPECS, type CliKind, type DetectedCli } from '@decky/shared'
import { t } from '../lib/i18n'

interface FirstRunModalProps {
  detectedClis: DetectedCli[]
  currentDefault: CliKind | null
  onSave: (kind: CliKind) => void | Promise<void>
  onSkip: () => void | Promise<void>
  onRecheck: () => Promise<DetectedCli[]>
  /** When false, hides the "skip" button — used when invoked from menu (no first-run obligation). */
  showSkip?: boolean
  /** Override the heading; defaults to the first-run wording. */
  heading?: string
}

interface PathEditorState {
  value: string
  validating: boolean
  error?: string
  okMsg?: string
}

const emptyEditor = (initial = ''): PathEditorState => ({
  value: initial,
  validating: false
})

export default function FirstRunModal({
  detectedClis,
  currentDefault,
  onSave,
  onSkip,
  onRecheck,
  showSkip = true,
  heading
}: FirstRunModalProps): React.JSX.Element {
  const initial: CliKind | null = currentDefault ?? detectedClis[0]?.kind ?? null
  const [selected, setSelected] = useState<CliKind | null>(initial)
  const [rechecking, setRechecking] = useState(false)
  const [editing, setEditing] = useState<CliKind | null>(null)
  const [editor, setEditor] = useState<PathEditorState>(emptyEditor())
  const [overrides, setOverrides] = useState<Partial<Record<CliKind, string>>>({})

  useEffect(() => {
    void window.deck.cli.getPaths().then(setOverrides)
  }, [])

  const byKind = new Map(detectedClis.map((c) => [c.kind, c]))
  const isEmpty = detectedClis.length === 0

  const refreshOverrides = async (): Promise<void> => {
    const p = await window.deck.cli.getPaths()
    setOverrides(p)
  }

  const handleRecheck = async (): Promise<void> => {
    setRechecking(true)
    try {
      const fresh = await onRecheck()
      if (!selected && fresh.length > 0) setSelected(fresh[0].kind)
    } finally {
      setRechecking(false)
    }
  }

  const startEdit = (kind: CliKind): void => {
    setEditing(kind)
    setEditor(emptyEditor(overrides[kind] ?? byKind.get(kind)?.bin ?? ''))
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setEditor(emptyEditor())
  }

  const browse = async (): Promise<void> => {
    const picked = await window.deck.app.pickFile(t('cli.pickFileDialog'))
    if (picked) setEditor((e) => ({ ...e, value: picked, error: undefined, okMsg: undefined }))
  }

  const savePath = async (kind: CliKind): Promise<void> => {
    const path = editor.value.trim()
    if (!path) return
    setEditor((e) => ({ ...e, validating: true, error: undefined, okMsg: undefined }))
    const v = await window.deck.cli.validatePath(path)
    if (!v.ok) {
      setEditor((e) => ({ ...e, validating: false, error: v.error ?? t('cli.invalid') }))
      return
    }
    await window.deck.cli.setPath(kind, path)
    const fresh = await onRecheck()
    await refreshOverrides()
    if (!selected && fresh.length > 0) setSelected(fresh[0].kind)
    setEditor((e) => ({
      ...e,
      validating: false,
      okMsg: v.version ? `${t('cli.okPrefix')}${v.version}` : t('cli.ok')
    }))
    // Auto-close after a brief moment so user sees confirmation.
    setTimeout(() => {
      setEditing(null)
      setEditor(emptyEditor())
    }, 700)
  }

  const clearPath = async (kind: CliKind): Promise<void> => {
    await window.deck.cli.setPath(kind, null)
    await onRecheck()
    await refreshOverrides()
    cancelEdit()
  }

  const renderEditor = (kind: CliKind): React.JSX.Element => {
    const hasOverride = !!overrides[kind]
    return (
      <div className="first-run-modal-editor">
        <div className="first-run-modal-editor-row">
          <input
            type="text"
            className="first-run-modal-editor-input"
            placeholder={t('cli.pathPlaceholder')}
            value={editor.value}
            onChange={(e) =>
              setEditor((s) => ({
                ...s,
                value: e.target.value,
                error: undefined,
                okMsg: undefined
              }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') void savePath(kind)
              if (e.key === 'Escape') cancelEdit()
            }}
            autoFocus
            spellCheck={false}
          />
          <button
            type="button"
            className="first-run-modal-editor-browse"
            onClick={() => void browse()}
            title={t('cli.pickFile')}
          >
            …
          </button>
        </div>
        {editor.error && <div className="first-run-modal-editor-error">{editor.error}</div>}
        {editor.okMsg && <div className="first-run-modal-editor-ok">{editor.okMsg}</div>}
        <div className="first-run-modal-editor-actions">
          <button
            type="button"
            className="first-run-modal-link"
            onClick={cancelEdit}
            disabled={editor.validating}
          >
            {t('common.cancel')}
          </button>
          {hasOverride && (
            <button
              type="button"
              className="first-run-modal-link"
              onClick={() => void clearPath(kind)}
              disabled={editor.validating}
            >
              {t('cli.clearOverride')}
            </button>
          )}
          <button
            type="button"
            className="first-run-modal-editor-save"
            onClick={() => void savePath(kind)}
            disabled={editor.validating || !editor.value.trim()}
          >
            {editor.validating ? t('cli.validating') : t('common.save')}
          </button>
        </div>
      </div>
    )
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
            {heading ?? (isEmpty ? t('cli.headingNoCli') : t('cli.headingChoose'))}
          </h2>
          <p className="first-run-modal-sub">
            {isEmpty ? t('cli.subEmpty') : t('cli.subPick')}
          </p>
        </div>

        <div className="first-run-modal-options">
          {CLI_KINDS.map((kind) => {
            const spec = CLI_SPECS[kind]
            const detected = byKind.get(kind)
            const override = overrides[kind]
            const isEditingThis = editing === kind

            return (
              <div key={kind} className="first-run-modal-row">
                <label className="first-run-modal-option" data-disabled={!detected || undefined}>
                  <input
                    type="radio"
                    name="default-cli"
                    value={kind}
                    checked={selected === kind}
                    onChange={() => detected && setSelected(kind)}
                    disabled={!detected}
                  />
                  <span className="first-run-modal-option-name">{spec.displayName}</span>
                  {detected?.version && (
                    <span className="first-run-modal-option-ver">{detected.version}</span>
                  )}
                  {!detected && (
                    <span className="first-run-modal-option-ver">{t('cli.notDetected')}</span>
                  )}
                  <button
                    type="button"
                    className="first-run-modal-link"
                    onClick={(e) => {
                      e.preventDefault()
                      isEditingThis ? cancelEdit() : startEdit(kind)
                    }}
                  >
                    {isEditingThis ? t('common.close') : override ? t('cli.edit') : t('cli.editPath')}
                  </button>
                </label>
                {detected && (
                  <div className="first-run-modal-option-path" title={detected.bin}>
                    {detected.bin}
                    {override && detected.bin === override && (
                      <span className="first-run-modal-option-tag">custom</span>
                    )}
                  </div>
                )}
                {!detected && (
                  <div className="first-run-modal-option-hint">
                    <code>{spec.installHint}</code>
                  </div>
                )}
                {isEditingThis && renderEditor(kind)}
              </div>
            )
          })}
        </div>

        <div className="first-run-modal-footer">
          {showSkip && (
            <button type="button" className="first-run-modal-skip" onClick={() => void onSkip()}>
              {isEmpty ? t('cli.skip') : t('common.close')}
            </button>
          )}
          {isEmpty ? (
            <button
              type="button"
              className="first-run-modal-action"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? t('cli.rechecking') : t('cli.recheck')}
            </button>
          ) : (
            <button
              type="button"
              className="first-run-modal-action"
              disabled={!selected}
              onClick={() => selected && void onSave(selected)}
            >
              {t('cli.useDefault')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

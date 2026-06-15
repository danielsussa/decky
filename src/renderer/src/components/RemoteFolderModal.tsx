import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Edit3, Folder, FolderPlus, Loader2, X } from 'lucide-react'
import type { Engine } from '@decky/shared'
import { t } from '../lib/i18n'

interface RemoteFolderModalProps {
  engine: Engine
  onDismiss: () => void
  onConfirm: (path: string) => void
}

const PATH_PROBE_DEBOUNCE_MS = 500

type PathProbe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'exists' }
  | { kind: 'missing' }
  | { kind: 'creating' }
  | { kind: 'error'; message: string }

type Mode = 'list' | 'custom'

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`
}

// Picker de pasta dentro de um engine remoto. Estado inicial = lista das pastas detectadas no
// $HOME do host (probe via ssh.exec("ls -d ~/*/")). Cada linha é clicável; a última, "Outra
// pasta…", alterna pro modo input livre com probe de existência + botão de criar. Sem browser
// navegável ainda (PR #32 atravessa subpastas, breadcrumbs etc).
export default function RemoteFolderModal({
  engine,
  onDismiss,
  onConfirm
}: RemoteFolderModalProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('list')
  const [home, setHome] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [loadingFolders, setLoadingFolders] = useState(true)
  const [selectedPath, setSelectedPath] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [pathProbe, setPathProbe] = useState<PathProbe>({ kind: 'idle' })
  const customRef = useRef<HTMLInputElement | null>(null)
  const listIdRef = useRef(0)
  const pathProbeIdRef = useRef(0)

  const sshHost = engine.sshHost ?? ''
  const sshIdentity = engine.sshIdentity

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && pathProbe.kind !== 'creating') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, pathProbe.kind])

  // Boot probe: $HOME + primeiras pastas em ~.
  useEffect(() => {
    if (!sshHost) return
    const id = ++listIdRef.current
    setLoadingFolders(true)
    void window.deck.ssh
      .exec({
        host: sshHost,
        command: 'echo "$HOME" && ls -d ~/*/ 2>/dev/null | head -30 || true',
        identity: sshIdentity,
        timeoutMs: 8000
      })
      .then((r) => {
        if (id !== listIdRef.current) return
        setLoadingFolders(false)
        if (!r.ok) return
        const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        const homeDir = lines[0] ?? ''
        const detected = lines
          .slice(1)
          .map((l) => l.replace(/\/$/, ''))
          .filter((p) => p.startsWith('/'))
        setHome(homeDir)
        setFolders(detected)
        // Pré-seleciona a primeira pasta como conveniência. User pode trocar com 1 click.
        if (detected.length > 0) setSelectedPath(detected[0])
      })
      .catch(() => {
        if (id !== listIdRef.current) return
        setLoadingFolders(false)
      })
  }, [sshHost, sshIdentity])

  // Quando entra no modo custom, foca o input + faz probe se já tem texto.
  useEffect(() => {
    if (mode === 'custom') customRef.current?.focus()
  }, [mode])

  // Probe do custom path.
  useEffect(() => {
    if (mode !== 'custom') {
      setPathProbe({ kind: 'idle' })
      return
    }
    const p = customPath.trim()
    if (!p || !sshHost) {
      setPathProbe({ kind: 'idle' })
      return
    }
    const timer = setTimeout(() => {
      const id = ++pathProbeIdRef.current
      setPathProbe({ kind: 'probing' })
      const cmd = `bash -c 'test -d ${shellEscape(p)} && echo EXISTS || echo MISSING'`
      void window.deck.ssh
        .exec({
          host: sshHost,
          command: cmd,
          identity: sshIdentity,
          timeoutMs: 6000
        })
        .then((r) => {
          if (id !== pathProbeIdRef.current) return
          if (!r.ok) {
            setPathProbe({ kind: 'error', message: r.error ?? `exit ${r.exitCode}` })
            return
          }
          const out = r.stdout.trim()
          if (out.includes('EXISTS')) setPathProbe({ kind: 'exists' })
          else setPathProbe({ kind: 'missing' })
        })
        .catch((err) => {
          if (id !== pathProbeIdRef.current) return
          setPathProbe({ kind: 'error', message: (err as Error).message })
        })
    }, PATH_PROBE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [mode, customPath, sshHost, sshIdentity])

  const createRemoteFolder = async (): Promise<void> => {
    const p = customPath.trim()
    if (!p || !sshHost) return
    setPathProbe({ kind: 'creating' })
    const cmd = `bash -c 'mkdir -p ${shellEscape(p)} && echo OK'`
    try {
      const r = await window.deck.ssh.exec({
        host: sshHost,
        command: cmd,
        identity: sshIdentity,
        timeoutMs: 6000
      })
      if (r.ok && r.stdout.includes('OK')) {
        setPathProbe({ kind: 'exists' })
      } else {
        setPathProbe({
          kind: 'error',
          message: r.stderr.trim() || r.error || `exit ${r.exitCode}`
        })
      }
    } catch (err) {
      setPathProbe({ kind: 'error', message: (err as Error).message })
    }
  }

  function resolveAbs(p: string): string {
    const trimmed = p.trim()
    if (!trimmed) return ''
    if (trimmed === '~') return home || trimmed
    if (trimmed.startsWith('~/')) return home ? `${home}/${trimmed.slice(2)}` : trimmed
    return trimmed
  }

  const effectivePath = mode === 'list' ? selectedPath : resolveAbs(customPath)
  const canSubmit =
    mode === 'list'
      ? selectedPath.length > 0
      : pathProbe.kind === 'exists' && customPath.trim().length > 0

  const submit = (e?: React.FormEvent): void => {
    if (e) e.preventDefault()
    if (!canSubmit || !effectivePath) return
    onConfirm(effectivePath)
  }

  return (
    <div
      className="add-server-modal-backdrop"
      onClick={() => pathProbe.kind !== 'creating' && onDismiss()}
    >
      <div
        className="add-server-modal add-server-modal-narrow"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-server-modal-header">
          <div className="add-server-modal-title">
            <FolderPlus size={18} />
            <span>
              {t('addFolder.remoteTitle').replace('{host}', engine.label)}
            </span>
          </div>
          <button
            type="button"
            className="add-server-modal-close"
            onClick={onDismiss}
            disabled={pathProbe.kind === 'creating'}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">
          {mode === 'list'
            ? t('addFolder.remoteSubtitleList').replace('{n}', String(folders.length))
            : t('addFolder.remoteSubtitleCustom')}
        </p>

        <form onSubmit={submit} className="add-server-modal-form">
          {mode === 'list' && (
            <div className="remote-folder-list">
              {loadingFolders && (
                <div className="remote-folder-loading">
                  <Loader2 size={14} className="add-server-modal-spinner" />
                  <span>{t('server.probing')}</span>
                </div>
              )}
              {!loadingFolders && folders.length === 0 && (
                <div className="remote-folder-empty">{t('addFolder.noFoldersDetected')}</div>
              )}
              {folders.map((p) => {
                const selected = p === selectedPath
                return (
                  <button
                    key={p}
                    type="button"
                    className={`remote-folder-row${selected ? ' remote-folder-row-selected' : ''}`}
                    onClick={() => setSelectedPath(p)}
                  >
                    <span className="remote-folder-icon">
                      <Folder size={14} />
                    </span>
                    <span className="remote-folder-path">{p}</span>
                    {selected && (
                      <span className="remote-folder-check">
                        <Check size={14} />
                      </span>
                    )}
                  </button>
                )
              })}
              <button
                type="button"
                className="remote-folder-row remote-folder-row-other"
                onClick={() => {
                  setMode('custom')
                  setCustomPath(home || '')
                }}
              >
                <span className="remote-folder-icon">
                  <Edit3 size={14} />
                </span>
                <span className="remote-folder-path">{t('addFolder.otherPath')}</span>
              </button>
            </div>
          )}

          {mode === 'custom' && (
            <label className="add-server-modal-field">
              <span className="add-server-modal-label-row">
                <span className="add-server-modal-label">{t('server.pathLabel')}</span>
                {pathProbe.kind === 'probing' && (
                  <span className="add-server-modal-probe add-server-modal-probe-working">
                    <Loader2 size={11} className="add-server-modal-spinner" />
                    {t('server.probing')}
                  </span>
                )}
                {pathProbe.kind === 'exists' && (
                  <span className="add-server-modal-probe add-server-modal-probe-ok">
                    <Check size={11} />
                    {t('server.pathExists')}
                  </span>
                )}
                {pathProbe.kind === 'missing' && (
                  <button
                    type="button"
                    className="add-server-modal-probe add-server-modal-probe-action"
                    onClick={() => void createRemoteFolder()}
                  >
                    {t('server.pathCreateAsk')}
                  </button>
                )}
                {pathProbe.kind === 'creating' && (
                  <span className="add-server-modal-probe add-server-modal-probe-working">
                    <Loader2 size={11} className="add-server-modal-spinner" />
                    {t('server.pathCreating')}
                  </span>
                )}
                {pathProbe.kind === 'error' && (
                  <span className="add-server-modal-probe add-server-modal-probe-error">
                    <AlertCircle size={11} />
                    {pathProbe.message}
                  </span>
                )}
              </span>
              <input
                ref={customRef}
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder={home || '/home/user/projeto'}
                autoComplete="off"
                spellCheck={false}
                disabled={pathProbe.kind === 'creating'}
              />
              <button
                type="button"
                className="remote-folder-back"
                onClick={() => {
                  setMode('list')
                  setCustomPath('')
                }}
                disabled={pathProbe.kind === 'creating'}
              >
                ← {t('addFolder.backToList')}
              </button>
            </label>
          )}

          <div className="add-server-modal-actions">
            <button
              type="button"
              className="add-server-modal-cancel"
              onClick={onDismiss}
              disabled={pathProbe.kind === 'creating'}
            >
              {t('server.cancel')}
            </button>
            <button
              type="submit"
              className="add-server-modal-connect"
              disabled={!canSubmit}
            >
              {t('addFolder.useThisFolder')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, FolderPlus, Loader2, X } from 'lucide-react'
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

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`
}

// Modal de escolha de pasta dentro de um engine remoto. Probe o path conforme o user digita;
// se não existir, oferece criar. Também busca em background as subpastas pra popular um datalist
// de sugestões. Sem browser navegável ainda — PR #32.
export default function RemoteFolderModal({
  engine,
  onDismiss,
  onConfirm
}: RemoteFolderModalProps): React.JSX.Element {
  const [path, setPath] = useState('')
  const [home, setHome] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [pathProbe, setPathProbe] = useState<PathProbe>({ kind: 'idle' })
  const pathRef = useRef<HTMLInputElement | null>(null)
  const pathProbeIdRef = useRef(0)
  const listIdRef = useRef(0)

  const sshHost = engine.sshHost ?? ''
  const sshIdentity = engine.sshIdentity

  useEffect(() => {
    pathRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && pathProbe.kind !== 'creating') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, pathProbe.kind])

  // Boot probe: pega $HOME do remote pra usar como placeholder + lista pastas pra sugestões.
  useEffect(() => {
    if (!sshHost) return
    const id = ++listIdRef.current
    void window.deck.ssh
      .exec({
        host: sshHost,
        command: 'echo "$HOME" && ls -d ~/*/ 2>/dev/null | head -30 || true',
        identity: sshIdentity,
        timeoutMs: 8000
      })
      .then((r) => {
        if (id !== listIdRef.current) return
        if (!r.ok) return
        const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        const homeDir = lines[0] ?? ''
        const folders = lines
          .slice(1)
          .map((l) => l.replace(/\/$/, ''))
          .filter((p) => p.startsWith('/'))
        setHome(homeDir)
        setSuggestions(folders)
      })
  }, [sshHost, sshIdentity])

  // Probe de existência do path digitado (debounce).
  useEffect(() => {
    const p = path.trim()
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
  }, [path, sshHost, sshIdentity])

  const createRemoteFolder = async (): Promise<void> => {
    const p = path.trim()
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

  // Resolve o path digitado pra absoluto (~ → $HOME) — o decky lá em cima usa cwd absoluto.
  function resolveAbs(p: string): string {
    const trimmed = p.trim()
    if (!trimmed) return ''
    if (trimmed === '~') return home || trimmed
    if (trimmed.startsWith('~/')) return home ? `${home}/${trimmed.slice(2)}` : trimmed
    return trimmed
  }

  const submit = (e?: React.FormEvent): void => {
    if (e) e.preventDefault()
    const abs = resolveAbs(path)
    if (!abs) return
    if (pathProbe.kind !== 'exists') return
    onConfirm(abs)
  }

  const canSubmit = pathProbe.kind === 'exists'
  const showCreate = pathProbe.kind === 'missing'

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
          {t('addFolder.remoteSubtitle').replace(
            '{n}',
            String(suggestions.length)
          )}
        </p>

        <form onSubmit={submit} className="add-server-modal-form">
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
              {showCreate && (
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
              ref={pathRef}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={home || '/home/user/projeto'}
              list="remote-folder-suggestions"
              autoComplete="off"
              spellCheck={false}
              disabled={pathProbe.kind === 'creating'}
            />
            <datalist id="remote-folder-suggestions">
              {suggestions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">
              {suggestions.length > 0
                ? t('server.pathHelpRemote').replace('{n}', String(suggestions.length))
                : t('server.pathHelp')}
            </span>
          </label>

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

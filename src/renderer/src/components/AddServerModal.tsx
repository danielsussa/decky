import { useEffect, useRef, useState } from 'react'
import { Server, X, Check, AlertCircle, Loader2 } from 'lucide-react'
import { t } from '../lib/i18n'

interface AddServerModalProps {
  onDismiss: () => void
}

// Sugestões estáticas. Servem como fallback enquanto a probe SSH não roda — quando ela retorna,
// o datalist do Path passa a usar as pastas reais detectadas no remote (`ls -d ~/*/`).
const COMMON_PATHS = ['~/dev', '~/code', '~/projects', '~/repos', '~/src', '/opt', '/var/www']
const COMMON_IDENTITIES = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa'
]

const HOST_PROBE_DEBOUNCE_MS = 600
const PATH_PROBE_DEBOUNCE_MS = 500

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting'; step: string }
  | { kind: 'ok'; output: string }
  | { kind: 'error'; message: string; output?: string }

type HostProbe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; user: string; home: string; folders: string[] }
  | { kind: 'error'; message: string }

type PathProbe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'exists' }
  | { kind: 'missing' }
  | { kind: 'creating' }
  | { kind: 'error'; message: string }

export default function AddServerModal({ onDismiss }: AddServerModalProps): React.JSX.Element {
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [identity, setIdentity] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [hostProbe, setHostProbe] = useState<HostProbe>({ kind: 'idle' })
  const [pathProbe, setPathProbe] = useState<PathProbe>({ kind: 'idle' })
  const hostRef = useRef<HTMLInputElement | null>(null)
  // IDs monotônicos das probes — se nova probe começar antes da antiga terminar, a antiga
  // descarta seu resultado (race protection sem AbortController, ssh2 não suporta cancel).
  const hostProbeIdRef = useRef(0)
  const pathProbeIdRef = useRef(0)

  useEffect(() => {
    hostRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && status.kind !== 'connecting') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, status.kind])

  // Auto-probe: depois que o user para de digitar o host (e/ou identity), tenta SSH connect
  // e usa o resultado pra popular as sugestões do Path. Cancela se algum dos dois mudar antes
  // do debounce expirar.
  useEffect(() => {
    const h = host.trim()
    if (!h) {
      setHostProbe({ kind: 'idle' })
      return
    }
    // Debounce. Reinicia em qualquer mudança em host/identity.
    const timer = setTimeout(() => {
      const id = ++hostProbeIdRef.current
      setHostProbe({ kind: 'probing' })
      const cmd = 'whoami && echo "$HOME" && ls -d ~/*/ 2>/dev/null | head -30 || true'
      void window.deck.ssh
        .exec({
          host: h,
          command: cmd,
          identity: identity.trim() || undefined,
          timeoutMs: 8000
        })
        .then((r) => {
          if (id !== hostProbeIdRef.current) return // probe nova começou, descartamos esta
          if (!r.ok) {
            setHostProbe({ kind: 'error', message: r.error ?? `exit ${r.exitCode}` })
            return
          }
          const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
          const user = lines[0] ?? ''
          const home = lines[1] ?? ''
          const folders = lines
            .slice(2)
            .map((l) => l.replace(/\/$/, ''))
            .filter((p) => p.startsWith('/'))
          setHostProbe({ kind: 'ok', user, home, folders })
        })
        .catch((err) => {
          if (id !== hostProbeIdRef.current) return
          setHostProbe({ kind: 'error', message: (err as Error).message })
        })
    }, HOST_PROBE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [host, identity])

  // Probe do path: só roda quando host já está OK. Verifica se o path existe; se não,
  // oferece "criar". Debounce maior pra não disparar a cada caractere digitado.
  useEffect(() => {
    const h = host.trim()
    const p = path.trim()
    if (!h || !p || hostProbe.kind !== 'ok') {
      setPathProbe({ kind: 'idle' })
      return
    }
    const timer = setTimeout(() => {
      const id = ++pathProbeIdRef.current
      setPathProbe({ kind: 'probing' })
      // bash -c pra ~ expandir corretamente (sem ele, ssh manda comando que /bin/sh executa).
      // Aspas escapadas pra prevenir injection.
      const safeP = p.replace(/'/g, "'\"'\"'")
      const cmd = `bash -c 'test -d '"'"'${safeP}'"'"' && echo EXISTS || echo MISSING'`
      void window.deck.ssh
        .exec({
          host: h,
          command: cmd,
          identity: identity.trim() || undefined,
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
  }, [host, path, identity, hostProbe.kind])

  const createRemoteFolder = async (): Promise<void> => {
    const h = host.trim()
    const p = path.trim()
    if (!h || !p) return
    setPathProbe({ kind: 'creating' })
    const safeP = p.replace(/'/g, "'\"'\"'")
    const cmd = `bash -c 'mkdir -p '"'"'${safeP}'"'"' && echo OK'`
    try {
      const r = await window.deck.ssh.exec({
        host: h,
        command: cmd,
        identity: identity.trim() || undefined,
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

  const submit = async (e?: React.FormEvent): Promise<void> => {
    if (e) e.preventDefault()
    const h = host.trim()
    const p = path.trim()
    if (!h || !p) return

    setStatus({ kind: 'connecting', step: t('server.statusConnecting') })
    const probeCmd = `echo "[decky-probe] connected" && uname -a && id -un && test -d ${JSON.stringify(p)} && echo "[decky-probe] path-ok ${p}" || echo "[decky-probe] path-missing ${p}"`
    try {
      const r = await window.deck.ssh.exec({
        host: h,
        command: probeCmd,
        identity: identity.trim() || undefined,
        timeoutMs: 15000
      })
      if (r.ok) {
        setStatus({ kind: 'ok', output: r.stdout.trim() })
      } else {
        setStatus({
          kind: 'error',
          message: r.error ?? `exit ${r.exitCode}`,
          output: [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
        })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }

  const connecting = status.kind === 'connecting'

  // Path suggestions = COMMON_PATHS + folders reais do remote (deduplicadas, remote first).
  const pathSuggestions =
    hostProbe.kind === 'ok'
      ? Array.from(new Set([...hostProbe.folders, ...COMMON_PATHS]))
      : COMMON_PATHS

  return (
    <div className="add-server-modal-backdrop" onClick={() => !connecting && onDismiss()}>
      <div
        className="add-server-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-server-modal-header">
          <div className="add-server-modal-title">
            <Server size={18} />
            <span>{t('server.title')}</span>
          </div>
          <button
            type="button"
            className="add-server-modal-close"
            onClick={onDismiss}
            disabled={connecting}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">{t('server.subtitle')}</p>

        <form onSubmit={(e) => void submit(e)} className="add-server-modal-form">
          <label className="add-server-modal-field">
            <span className="add-server-modal-label-row">
              <span className="add-server-modal-label">{t('server.hostLabel')}</span>
              {hostProbe.kind === 'probing' && (
                <span className="add-server-modal-probe add-server-modal-probe-working">
                  <Loader2 size={11} className="add-server-modal-spinner" />
                  {t('server.probing')}
                </span>
              )}
              {hostProbe.kind === 'ok' && (
                <span className="add-server-modal-probe add-server-modal-probe-ok">
                  <Check size={11} />
                  {hostProbe.user}@ — {hostProbe.home}
                </span>
              )}
              {hostProbe.kind === 'error' && (
                <span className="add-server-modal-probe add-server-modal-probe-error">
                  <AlertCircle size={11} />
                  {hostProbe.message}
                </span>
              )}
            </span>
            <input
              ref={hostRef}
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="user@minha-maquina.tail-xxxx.ts.net"
              autoComplete="off"
              spellCheck={false}
              disabled={connecting}
            />
            <span className="add-server-modal-help">{t('server.hostHelp')}</span>
          </label>

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
                  disabled={connecting}
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
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={hostProbe.kind === 'ok' ? hostProbe.home : '/home/user/projeto'}
              list="add-server-path-suggestions"
              autoComplete="off"
              spellCheck={false}
              disabled={connecting}
            />
            <datalist id="add-server-path-suggestions">
              {pathSuggestions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">
              {hostProbe.kind === 'ok' && hostProbe.folders.length > 0
                ? t('server.pathHelpRemote').replace('{n}', String(hostProbe.folders.length))
                : t('server.pathHelp')}
            </span>
          </label>

          <label className="add-server-modal-field">
            <span className="add-server-modal-label">{t('server.identityLabel')}</span>
            <input
              type="text"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
              list="add-server-identity-suggestions"
              autoComplete="off"
              spellCheck={false}
              disabled={connecting}
            />
            <datalist id="add-server-identity-suggestions">
              {COMMON_IDENTITIES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">{t('server.identityHelp')}</span>
          </label>

          {status.kind === 'connecting' && (
            <div className="add-server-modal-status add-server-modal-status-working">
              <Loader2 className="add-server-modal-spinner" size={14} />
              <span>{status.step}</span>
            </div>
          )}

          {status.kind === 'ok' && (
            <div className="add-server-modal-status add-server-modal-status-ok">
              <Check size={14} />
              <div className="add-server-modal-status-body">
                <span className="add-server-modal-status-title">{t('server.statusOk')}</span>
                <pre className="add-server-modal-output">{status.output || '(no output)'}</pre>
              </div>
            </div>
          )}

          {status.kind === 'error' && (
            <div className="add-server-modal-status add-server-modal-status-error">
              <AlertCircle size={14} />
              <div className="add-server-modal-status-body">
                <span className="add-server-modal-status-title">{status.message}</span>
                {status.output && (
                  <pre className="add-server-modal-output">{status.output}</pre>
                )}
              </div>
            </div>
          )}

          <div className="add-server-modal-actions">
            <button
              type="button"
              className="add-server-modal-cancel"
              onClick={onDismiss}
              disabled={connecting}
            >
              {t('server.cancel')}
            </button>
            <button
              type="submit"
              className="add-server-modal-connect"
              disabled={!host.trim() || !path.trim() || connecting}
            >
              {connecting ? t('server.statusConnecting') : t('server.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Server, X, Check, AlertCircle, Loader2 } from 'lucide-react'
import { t } from '../lib/i18n'

interface AddServerModalProps {
  onDismiss: () => void
}

// Sugestões estáticas pros datalists. Sem SSH conectado ainda — não dá pra fazer completion
// dinâmica do remote (`ssh user@host "ls ~"`). Quando o SSH connect estiver pronto (PR #25+),
// estas viram apenas o fallback e a maior parte das opções vem do remote.
const COMMON_PATHS = ['~/dev', '~/code', '~/projects', '~/repos', '~/src', '/opt', '/var/www']
const COMMON_IDENTITIES = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa'
]

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting'; step: string }
  | { kind: 'ok'; output: string }
  | { kind: 'error'; message: string; output?: string }

export default function AddServerModal({ onDismiss }: AddServerModalProps): React.JSX.Element {
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [identity, setIdentity] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const hostRef = useRef<HTMLInputElement | null>(null)

  // Autofocus no Host SÓ na primeira montagem — sem deps. Misturar com o listener de Esc (que
  // depende de onDismiss + status.kind) fazia o efeito re-executar a cada mudança de status,
  // roubando o foco de volta pro Host enquanto o user tentava digitar no Path/Identity.
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

  const submit = async (e?: React.FormEvent): Promise<void> => {
    if (e) e.preventDefault()
    const h = host.trim()
    const p = path.trim()
    if (!h || !p) return

    // PR #25 — só prova que SSH funciona. Roda `echo + uname -a + pwd + ls -d <path>`.
    // Próximas PRs trocam por: detect server, install, start, tunnel, connect.
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
            <span className="add-server-modal-label">{t('server.hostLabel')}</span>
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
            <span className="add-server-modal-label">{t('server.pathLabel')}</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/projeto"
              list="add-server-path-suggestions"
              autoComplete="off"
              spellCheck={false}
              disabled={connecting}
            />
            <datalist id="add-server-path-suggestions">
              {COMMON_PATHS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">{t('server.pathHelp')}</span>
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

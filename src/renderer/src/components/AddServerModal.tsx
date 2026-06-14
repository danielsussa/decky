import { useEffect, useRef, useState } from 'react'
import { Server, X } from 'lucide-react'
import { t } from '../lib/i18n'

interface AddServerModalProps {
  onDismiss: () => void
  /** Recebe a config; UX-only por enquanto, modal mostra mensagem "ainda não implementado". */
  onConnect: (config: { host: string; path: string; identity: string }) => void
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

export default function AddServerModal({
  onDismiss,
  onConnect
}: AddServerModalProps): React.JSX.Element {
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [identity, setIdentity] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const hostRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    hostRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const submit = (e?: React.FormEvent): void => {
    if (e) e.preventDefault()
    const h = host.trim()
    const p = path.trim()
    if (!h || !p) return
    onConnect({ host: h, path: p, identity: identity.trim() })
    setNotice(`${t('server.notImplemented')} ${h}:${p}`)
  }

  return (
    <div className="add-server-modal-backdrop" onClick={onDismiss}>
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
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">{t('server.subtitle')}</p>

        <form onSubmit={submit} className="add-server-modal-form">
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
            />
            <datalist id="add-server-identity-suggestions">
              {COMMON_IDENTITIES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">{t('server.identityHelp')}</span>
          </label>

          {notice && <div className="add-server-modal-notice">{notice}</div>}

          <div className="add-server-modal-actions">
            <button type="button" className="add-server-modal-cancel" onClick={onDismiss}>
              {t('server.cancel')}
            </button>
            <button
              type="submit"
              className="add-server-modal-connect"
              disabled={!host.trim() || !path.trim()}
            >
              {t('server.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

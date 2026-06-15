import { useEffect, useRef, useState } from 'react'
import { Server, X, Check, AlertCircle, Loader2, Circle } from 'lucide-react'
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
const REMOTE_SERVER_PATH = '~/.decky-server/dist/decky-server.js'

type StepState = 'pending' | 'running' | 'ok' | 'error'

interface FlowStep {
  id: string
  label: string
  state: StepState
  detail?: string
}

type Flow =
  | { kind: 'idle' }
  | { kind: 'running'; steps: FlowStep[] }
  | { kind: 'needs-install'; steps: FlowStep[] }
  | { kind: 'ready'; steps: FlowStep[] }
  | { kind: 'error'; steps: FlowStep[]; message: string }

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

function shellEscape(s: string): string {
  // Quote single-quoted string. Ex: `a'b` vira `'a'"'"'b'`.
  return `'${s.replace(/'/g, "'\"'\"'")}'`
}

export default function AddServerModal({ onDismiss }: AddServerModalProps): React.JSX.Element {
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [identity, setIdentity] = useState('')
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' })
  const [hostProbe, setHostProbe] = useState<HostProbe>({ kind: 'idle' })
  const [pathProbe, setPathProbe] = useState<PathProbe>({ kind: 'idle' })
  const hostRef = useRef<HTMLInputElement | null>(null)
  const hostProbeIdRef = useRef(0)
  const pathProbeIdRef = useRef(0)

  useEffect(() => {
    hostRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && flow.kind !== 'running') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, flow.kind])

  // Auto-probe do host: roda em background quando user digita o Host (debounce).
  useEffect(() => {
    const h = host.trim()
    if (!h) {
      setHostProbe({ kind: 'idle' })
      return
    }
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
          if (id !== hostProbeIdRef.current) return
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

  // Probe do path: só roda quando host já está OK. Oferece "criar" se não existe.
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
      const cmd = `bash -c 'test -d ${shellEscape(p)} && echo EXISTS || echo MISSING'`
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
    const cmd = `bash -c 'mkdir -p ${shellEscape(p)} && echo OK'`
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

  // Reusa o ssh.exec mas atualiza imutavelmente um step da lista. Retorna o stdout do step
  // (ou erro) pra próxima etapa decidir.
  async function runStep(
    steps: FlowStep[],
    stepId: string,
    cmd: string,
    timeoutMs = 10000
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    const h = host.trim()
    setFlow({
      kind: 'running',
      steps: steps.map((s) => (s.id === stepId ? { ...s, state: 'running' } : s))
    })
    const r = await window.deck.ssh.exec({
      host: h,
      command: cmd,
      identity: identity.trim() || undefined,
      timeoutMs
    })
    return {
      ok: r.ok,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error
    }
  }

  const handleConnect = async (): Promise<void> => {
    const h = host.trim()
    const p = path.trim()
    if (!h || !p) return

    // Steps iniciais. Adicionar mais nas PRs #27 (install) e #28 (start + tunnel).
    const initialSteps: FlowStep[] = [
      { id: 'ssh', label: t('server.stepSsh'), state: 'pending' },
      { id: 'detect', label: t('server.stepDetect'), state: 'pending' }
    ]
    setFlow({ kind: 'running', steps: initialSteps })

    // STEP 1 — SSH connectivity
    {
      const r = await runStep(initialSteps, 'ssh', 'echo SSH_OK', 8000)
      if (!r.ok || !r.stdout.includes('SSH_OK')) {
        const stepsAfter: FlowStep[] = initialSteps.map((s) =>
          s.id === 'ssh' ? { ...s, state: 'error', detail: r.error ?? r.stderr } : s
        )
        setFlow({ kind: 'error', steps: stepsAfter, message: r.error ?? t('server.errSsh') })
        return
      }
      initialSteps[0] = { ...initialSteps[0], state: 'ok' }
      setFlow({ kind: 'running', steps: [...initialSteps] })
    }

    // STEP 2 — Detect decky-server install
    {
      // Path test: arquivo principal do bundle existe? Eventualmente lê um arquivo `version`
      // pra mostrar a versão e detectar mismatch (PR seguinte). Por enquanto presence-check
      // simples é suficiente.
      const cmd = `test -f ${shellEscape(REMOTE_SERVER_PATH.replace('~', '$HOME'))} && echo INSTALLED || echo MISSING`
      const r = await runStep(initialSteps, 'detect', `bash -c ${shellEscape(cmd)}`, 6000)
      if (!r.ok) {
        const stepsAfter: FlowStep[] = initialSteps.map((s) =>
          s.id === 'detect' ? { ...s, state: 'error', detail: r.error ?? r.stderr } : s
        )
        setFlow({ kind: 'error', steps: stepsAfter, message: r.error ?? t('server.errDetect') })
        return
      }
      const installed = r.stdout.includes('INSTALLED')
      const detail = installed
        ? t('server.detectInstalled')
        : t('server.detectMissing')
      initialSteps[1] = { ...initialSteps[1], state: 'ok', detail }
      if (installed) {
        // PR #28 adiciona: start server + tunnel + ws connect. Por ora, fica "ready".
        setFlow({ kind: 'ready', steps: [...initialSteps] })
      } else {
        // PR #27 vai implementar o install real. Por ora, sinaliza que precisa.
        setFlow({ kind: 'needs-install', steps: [...initialSteps] })
      }
    }
  }

  const running = flow.kind === 'running'
  const interactive = !running && flow.kind !== 'needs-install' && flow.kind !== 'ready'

  // Path suggestions = COMMON_PATHS + folders reais do remote (deduplicadas, remote first).
  const pathSuggestions =
    hostProbe.kind === 'ok'
      ? Array.from(new Set([...hostProbe.folders, ...COMMON_PATHS]))
      : COMMON_PATHS

  // Botão principal muda de label conforme o estado:
  //   idle/error            → "Connect"
  //   running               → "Connecting…" (disabled)
  //   needs-install         → "Install decky-server" (próxima PR liga o handler)
  //   ready                 → "Open workspace" (próxima PR liga o handler)
  const primaryLabel =
    flow.kind === 'running'
      ? t('server.statusConnecting')
      : flow.kind === 'needs-install'
        ? t('server.btnInstall')
        : flow.kind === 'ready'
          ? t('server.btnOpen')
          : t('server.connect')

  const primaryDisabled =
    !host.trim() || !path.trim() || running || flow.kind === 'needs-install' || flow.kind === 'ready'
  // ⬆ needs-install/ready ficam desabilitados porque o handler real é das PRs #27/#28 — o user
  // já vê o resultado da #26, mas não tem ainda o passo seguinte plugado.

  return (
    <div className="add-server-modal-backdrop" onClick={() => !running && onDismiss()}>
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
            disabled={running}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <p className="add-server-modal-subtitle">{t('server.subtitle')}</p>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleConnect()
          }}
          className="add-server-modal-form"
        >
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
              disabled={!interactive}
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
                  disabled={!interactive}
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
              disabled={!interactive}
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
              disabled={!interactive}
            />
            <datalist id="add-server-identity-suggestions">
              {COMMON_IDENTITIES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="add-server-modal-help">{t('server.identityHelp')}</span>
          </label>

          {flow.kind !== 'idle' && (
            <div className="add-server-modal-steps">
              {flow.kind === 'error' && (
                <div className="add-server-modal-steps-banner add-server-modal-steps-banner-error">
                  <AlertCircle size={13} />
                  <span>{flow.message}</span>
                </div>
              )}
              {flow.kind === 'needs-install' && (
                <div className="add-server-modal-steps-banner add-server-modal-steps-banner-warn">
                  <AlertCircle size={13} />
                  <span>{t('server.installNeeded')}</span>
                </div>
              )}
              {flow.kind === 'ready' && (
                <div className="add-server-modal-steps-banner add-server-modal-steps-banner-ok">
                  <Check size={13} />
                  <span>{t('server.ready')}</span>
                </div>
              )}
              <ul className="add-server-modal-steps-list">
                {flow.steps.map((s) => (
                  <li
                    key={s.id}
                    className={`add-server-modal-step add-server-modal-step-${s.state}`}
                  >
                    <span className="add-server-modal-step-icon">
                      {s.state === 'pending' && <Circle size={12} />}
                      {s.state === 'running' && (
                        <Loader2 size={12} className="add-server-modal-spinner" />
                      )}
                      {s.state === 'ok' && <Check size={12} />}
                      {s.state === 'error' && <AlertCircle size={12} />}
                    </span>
                    <span className="add-server-modal-step-label">{s.label}</span>
                    {s.detail && (
                      <span className="add-server-modal-step-detail">{s.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="add-server-modal-actions">
            <button
              type="button"
              className="add-server-modal-cancel"
              onClick={onDismiss}
              disabled={running}
            >
              {t('server.cancel')}
            </button>
            <button
              type="submit"
              className="add-server-modal-connect"
              disabled={primaryDisabled}
            >
              {primaryLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

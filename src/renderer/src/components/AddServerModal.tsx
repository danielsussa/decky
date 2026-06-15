import { useEffect, useRef, useState } from 'react'
import { Server, X, Check, AlertCircle, Loader2, Circle } from 'lucide-react'
import { t } from '../lib/i18n'

interface AddServerModalProps {
  onDismiss: () => void
  // Chamado quando o server entra na árvore como engine. Sem workspace path — o user adiciona
  // pastas (locais ou remotas) depois via "Add folder". engineId é o id do engine recém-criado
  // pelo main.
  onAdded: (engineId: string) => void
}

const COMMON_IDENTITIES = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa'
]

const HOST_PROBE_DEBOUNCE_MS = 600
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
  | { kind: 'ok'; user: string; home: string }
  | { kind: 'error'; message: string }

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`
}

export default function AddServerModal({
  onDismiss,
  onAdded
}: AddServerModalProps): React.JSX.Element {
  const [host, setHost] = useState('')
  const [identity, setIdentity] = useState('')
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' })
  const [hostProbe, setHostProbe] = useState<HostProbe>({ kind: 'idle' })
  const hostRef = useRef<HTMLInputElement | null>(null)
  const hostProbeIdRef = useRef(0)

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

  // Probe do host: roda em background depois que o user para de digitar. Só pra mostrar feedback
  // visual ("✓ pi@ — /home/pi") confirmando que a conexão SSH + auth tão OK antes de o user
  // clicar Connect. O Connect refaz o handshake — o probe não substitui, só dá confirmação cedo.
  useEffect(() => {
    const h = host.trim()
    if (!h) {
      setHostProbe({ kind: 'idle' })
      return
    }
    const timer = setTimeout(() => {
      const id = ++hostProbeIdRef.current
      setHostProbe({ kind: 'probing' })
      void window.deck.ssh
        .exec({
          host: h,
          command: 'whoami && echo "$HOME"',
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
          setHostProbe({
            kind: 'ok',
            user: lines[0] ?? '',
            home: lines[1] ?? ''
          })
        })
        .catch((err) => {
          if (id !== hostProbeIdRef.current) return
          setHostProbe({ kind: 'error', message: (err as Error).message })
        })
    }, HOST_PROBE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [host, identity])

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
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error }
  }

  const installStepLabels: Record<string, string> = {
    'node-check': t('server.stepNodeCheck'),
    mkdir: t('server.stepMkdir'),
    'upload-bundle': t('server.stepUpload'),
    'write-package': t('server.stepWritePkg'),
    'npm-install': t('server.stepNpm')
  }
  const openStepLabels: Record<string, string> = {
    'start-server': t('server.stepStart'),
    'wait-token': t('server.stepToken'),
    'open-tunnel': t('server.stepTunnel')
  }

  const handleConnect = async (): Promise<void> => {
    const h = host.trim()
    if (!h) return

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
      const detail = installed ? t('server.detectInstalled') : t('server.detectMissing')
      initialSteps[1] = { ...initialSteps[1], state: 'ok', detail }
      if (installed) {
        setFlow({ kind: 'ready', steps: [...initialSteps] })
      } else {
        setFlow({ kind: 'needs-install', steps: [...initialSteps] })
      }
    }
  }

  const handleInstall = async (): Promise<void> => {
    const h = host.trim()
    if (!h) return
    if (flow.kind !== 'needs-install') return

    const baseSteps = flow.steps
    const installSteps: FlowStep[] = [
      { id: 'node-check', label: installStepLabels['node-check'], state: 'pending' },
      { id: 'mkdir', label: installStepLabels['mkdir'], state: 'pending' },
      { id: 'upload-bundle', label: installStepLabels['upload-bundle'], state: 'pending' },
      { id: 'write-package', label: installStepLabels['write-package'], state: 'pending' },
      { id: 'npm-install', label: installStepLabels['npm-install'], state: 'pending' }
    ]
    let combined = [...baseSteps, ...installSteps]
    setFlow({ kind: 'running', steps: combined })

    const unsubscribe = window.deck.ssh.onInstallProgress((ev) => {
      if (ev.kind === 'step') {
        combined = combined.map((s) =>
          s.id === ev.step.id
            ? { ...s, state: ev.step.state, detail: ev.step.detail ?? s.detail }
            : s
        )
        setFlow({ kind: 'running', steps: [...combined] })
      }
    })

    try {
      const r = await window.deck.ssh.installDeckyServer({
        host: h,
        identity: identity.trim() || undefined
      })
      if (r.ok) {
        setFlow({ kind: 'ready', steps: combined })
      } else {
        setFlow({
          kind: 'error',
          steps: combined,
          message: r.error ?? t('server.errInstall')
        })
      }
    } catch (err) {
      setFlow({
        kind: 'error',
        steps: combined,
        message: (err as Error).message
      })
    } finally {
      unsubscribe()
    }
  }

  const handleAddServer = async (): Promise<void> => {
    const h = host.trim()
    if (!h) return
    if (flow.kind !== 'ready') return

    const baseSteps = flow.steps
    const openSteps: FlowStep[] = [
      { id: 'start-server', label: openStepLabels['start-server'], state: 'pending' },
      { id: 'wait-token', label: openStepLabels['wait-token'], state: 'pending' },
      { id: 'open-tunnel', label: openStepLabels['open-tunnel'], state: 'pending' }
    ]
    let combined = [...baseSteps, ...openSteps]
    setFlow({ kind: 'running', steps: combined })

    const unsubscribe = window.deck.ssh.onInstallProgress((ev) => {
      if (ev.kind === 'step') {
        combined = combined.map((s) =>
          s.id === ev.step.id
            ? { ...s, state: ev.step.state, detail: ev.step.detail ?? s.detail }
            : s
        )
        setFlow({ kind: 'running', steps: [...combined] })
      }
    })

    try {
      const r = await window.deck.ssh.openRemote({
        host: h,
        identity: identity.trim() || undefined
      })
      if (!r.ok || !r.localUrl || !r.token) {
        setFlow({
          kind: 'error',
          steps: combined,
          message: r.error ?? t('server.errOpen')
        })
        return
      }
      // Engine sem workspace: aparece na sidebar como container vazio. User adiciona pastas
      // depois via "Add folder" (próxima PR — vai perguntar a engine + path).
      const engine = await window.deck.engines.add({
        label: h,
        url: r.localUrl,
        token: r.token,
        sshHost: h,
        sshIdentity: identity.trim() || undefined
      })
      onAdded(engine.id)
      onDismiss()
    } catch (err) {
      setFlow({
        kind: 'error',
        steps: combined,
        message: (err as Error).message
      })
    } finally {
      unsubscribe()
    }
  }

  const running = flow.kind === 'running'
  const interactive = !running && flow.kind !== 'needs-install' && flow.kind !== 'ready'

  const primaryLabel =
    flow.kind === 'running'
      ? t('server.statusConnecting')
      : flow.kind === 'needs-install'
        ? t('server.btnInstall')
        : flow.kind === 'ready'
          ? t('server.btnAddServer')
          : t('server.connect')

  const primaryDisabled = !host.trim() || running

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
            if (flow.kind === 'needs-install') {
              void handleInstall()
            } else if (flow.kind === 'ready') {
              void handleAddServer()
            } else if (flow.kind === 'idle' || flow.kind === 'error') {
              void handleConnect()
            }
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

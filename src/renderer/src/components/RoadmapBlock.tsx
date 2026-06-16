import { useEffect, useMemo, useRef, useState } from 'react'
import { registerWidget, registerWidgetType } from '../lib/widget-registry'

registerWidgetType({
  type: 'roadmap',
  fence: '```roadmap',
  description:
    'Horizontal timeline of milestones with status (todo/in_progress/done) and dependencies. Click a milestone to cycle its status. Progress bar at top.',
  specSchema:
    '{ "id": string, "readonly?": boolean (default false — when true, user can\'t click to cycle status; AI ops still work), "milestones": [{ "id", "label", "date?": "YYYY-MM-DD", "status?": "todo|in_progress|done", "deps?": ["<milestoneId>"] }] }',
  ops: [
    {
      name: 'addMilestone',
      description: 'Append a milestone.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          status: { type: 'string', description: 'todo | in_progress | done' },
          deps: { type: 'array', description: 'Array of milestone ids it depends on' }
        },
        required: ['id', 'label']
      }
    },
    {
      name: 'removeMilestone',
      description: 'Remove a milestone (and clean up dep references).',
      args: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    },
    {
      name: 'setStatus',
      description: 'Set status of a milestone. Triggers a flash animation.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', description: 'todo | in_progress | done' }
        },
        required: ['id', 'status']
      }
    },
    {
      name: 'setDate',
      description: 'Set the date of a milestone (YYYY-MM-DD).',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          date: { type: 'string' }
        },
        required: ['id', 'date']
      }
    },
    {
      name: 'addDependency',
      description: 'Make `id` depend on `dependsOn`.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          dependsOn: { type: 'string' }
        },
        required: ['id', 'dependsOn']
      }
    },
    {
      name: 'removeDependency',
      description: 'Drop dependency `dependsOn` from `id`.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          dependsOn: { type: 'string' }
        },
        required: ['id', 'dependsOn']
      }
    }
  ],
  getters: [
    { name: 'milestones', description: 'Current ordered milestones array (sorted by date asc)' },
    { name: 'progress', description: '{ done, total, percent } overall progress' },
    { name: 'nextMilestone', description: 'Next todo milestone whose deps are all done (or null)' }
  ]
})

type MilestoneStatus = 'todo' | 'in_progress' | 'done'

interface Milestone {
  id: string
  label: string
  date?: string
  status: MilestoneStatus
  deps: string[]
}

interface RoadmapSpec {
  id?: string
  readonly?: boolean
  milestones: Milestone[]
}

const STATUSES: MilestoneStatus[] = ['todo', 'in_progress', 'done']

function isStatus(s: unknown): s is MilestoneStatus {
  return s === 'todo' || s === 'in_progress' || s === 'done'
}

function cycleStatus(s: MilestoneStatus): MilestoneStatus {
  return STATUSES[(STATUSES.indexOf(s) + 1) % STATUSES.length]
}

function sortByDate(ms: Milestone[]): Milestone[] {
  return [...ms].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date)
    if (a.date) return -1
    if (b.date) return 1
    return 0
  })
}

function parseSpec(code: string): { spec: RoadmapSpec | null; error: string | null } {
  try {
    const parsed = JSON.parse(code) as Partial<RoadmapSpec>
    if (!parsed || !Array.isArray(parsed.milestones)) {
      return { spec: null, error: 'spec needs { milestones: [{ id, label, ... }] }' }
    }
    const milestones: Milestone[] = []
    for (const m of parsed.milestones) {
      if (!m || typeof m.id !== 'string' || typeof m.label !== 'string') continue
      milestones.push({
        id: m.id,
        label: m.label,
        date: typeof m.date === 'string' ? m.date : undefined,
        status: isStatus(m.status) ? m.status : 'todo',
        deps: Array.isArray(m.deps) ? m.deps.filter((d): d is string => typeof d === 'string') : []
      })
    }
    return {
      spec: {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        readonly: parsed.readonly === true,
        milestones
      },
      error: null
    }
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

function formatShortDate(date?: string): string {
  if (!date) return ''
  const [y, m, d] = date.split('-')
  if (!y || !m || !d) return date
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  const idx = parseInt(m, 10) - 1
  return `${d} ${months[idx] ?? m}/${y.slice(2)}`
}

function statusIcon(s: MilestoneStatus, blocked: boolean): string {
  if (blocked) return '⛔'
  if (s === 'done') return '✅'
  if (s === 'in_progress') return '🟡'
  return '⏳'
}

interface RoadmapBlockProps {
  code: string
  cardId: string
}

export default function RoadmapBlock({ code, cardId }: RoadmapBlockProps): React.JSX.Element {
  const [debounced, setDebounced] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 80)
    return () => clearTimeout(t)
  }, [code])

  const { spec, error } = useMemo(() => parseSpec(debounced), [debounced])

  const [milestones, setMilestones] = useState<Milestone[]>(spec?.milestones ?? [])
  const [flashId, setFlashId] = useState<string | null>(null)

  useEffect(() => {
    if (spec) setMilestones(spec.milestones)
  }, [spec])

  const milestonesRef = useRef(milestones)
  useEffect(() => {
    milestonesRef.current = milestones
  }, [milestones])

  const flash = (id: string): void => {
    setFlashId(id)
    setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 600)
  }

  const widgetId = spec?.id
  useEffect(() => {
    if (!cardId || !widgetId) return
    const computeProgress = (): { done: number; total: number; percent: number } => {
      const ms = milestonesRef.current
      const done = ms.filter((m) => m.status === 'done').length
      const total = ms.length
      return {
        done,
        total,
        percent: total === 0 ? 0 : Math.round((done / total) * 100)
      }
    }
    const computeNext = (): Milestone | null => {
      const ms = milestonesRef.current
      const doneIds = new Set(ms.filter((m) => m.status === 'done').map((m) => m.id))
      const sorted = sortByDate(ms)
      return (
        sorted.find((m) => m.status === 'todo' && m.deps.every((d) => doneIds.has(d))) ?? null
      )
    }
    return registerWidget(cardId, widgetId, {
      type: 'roadmap',
      ops: {
        addMilestone: (args) => {
          const a = (args ?? {}) as Partial<Milestone>
          if (typeof a.id !== 'string' || typeof a.label !== 'string')
            throw new Error('addMilestone: id + label required')
          setMilestones((ms) =>
            ms.some((m) => m.id === a.id)
              ? ms
              : [
                  ...ms,
                  {
                    id: a.id!,
                    label: a.label!,
                    date: typeof a.date === 'string' ? a.date : undefined,
                    status: isStatus(a.status) ? a.status : 'todo',
                    deps: Array.isArray(a.deps)
                      ? a.deps.filter((d): d is string => typeof d === 'string')
                      : []
                  }
                ]
          )
          flash(a.id)
          return { ok: true }
        },
        removeMilestone: (args) => {
          const a = (args ?? {}) as { id?: string }
          if (typeof a.id !== 'string') throw new Error('removeMilestone: id required')
          setMilestones((ms) =>
            ms
              .filter((m) => m.id !== a.id)
              .map((m) => ({ ...m, deps: m.deps.filter((d) => d !== a.id) }))
          )
          return { ok: true }
        },
        setStatus: (args) => {
          const a = (args ?? {}) as { id?: string; status?: string }
          if (typeof a.id !== 'string') throw new Error('setStatus: id required')
          if (!isStatus(a.status)) throw new Error('setStatus: status must be todo|in_progress|done')
          setMilestones((ms) =>
            ms.map((m) => (m.id === a.id ? { ...m, status: a.status as MilestoneStatus } : m))
          )
          flash(a.id)
          return { ok: true, status: a.status }
        },
        setDate: (args) => {
          const a = (args ?? {}) as { id?: string; date?: string }
          if (typeof a.id !== 'string' || typeof a.date !== 'string')
            throw new Error('setDate: id + date required')
          setMilestones((ms) => ms.map((m) => (m.id === a.id ? { ...m, date: a.date } : m)))
          flash(a.id)
          return { ok: true }
        },
        addDependency: (args) => {
          const a = (args ?? {}) as { id?: string; dependsOn?: string }
          if (typeof a.id !== 'string' || typeof a.dependsOn !== 'string')
            throw new Error('addDependency: id + dependsOn required')
          if (a.id === a.dependsOn) throw new Error('addDependency: cannot depend on self')
          setMilestones((ms) =>
            ms.map((m) =>
              m.id === a.id && !m.deps.includes(a.dependsOn!)
                ? { ...m, deps: [...m.deps, a.dependsOn!] }
                : m
            )
          )
          flash(a.id)
          return { ok: true }
        },
        removeDependency: (args) => {
          const a = (args ?? {}) as { id?: string; dependsOn?: string }
          if (typeof a.id !== 'string' || typeof a.dependsOn !== 'string')
            throw new Error('removeDependency: id + dependsOn required')
          setMilestones((ms) =>
            ms.map((m) => (m.id === a.id ? { ...m, deps: m.deps.filter((d) => d !== a.dependsOn) } : m))
          )
          return { ok: true }
        }
      },
      getters: {
        milestones: () => sortByDate(milestonesRef.current),
        progress: computeProgress,
        nextMilestone: computeNext
      }
    })
  }, [cardId, widgetId])

  const sorted = useMemo(() => sortByDate(milestones), [milestones])
  const labelById = useMemo(() => {
    const m: Record<string, string> = {}
    for (const ms of milestones) m[ms.id] = ms.label
    return m
  }, [milestones])
  const doneIds = useMemo(
    () => new Set(milestones.filter((m) => m.status === 'done').map((m) => m.id)),
    [milestones]
  )
  const progress = useMemo(() => {
    const done = milestones.filter((m) => m.status === 'done').length
    const total = milestones.length
    return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
  }, [milestones])

  const readOnly = spec?.readonly === true

  const onClickStatus = (id: string): void => {
    if (readOnly) return
    setMilestones((ms) =>
      ms.map((m) => (m.id === id ? { ...m, status: cycleStatus(m.status) } : m))
    )
    flash(id)
  }

  return (
    <div className={`roadmap-block${readOnly ? ' is-readonly' : ''}`}>
      {error ? <div className="roadmap-block-error">roadmap: {error}</div> : null}
      {readOnly ? <div className="widget-ai-badge" title="Read-only: só a AI pode mutar via ops">AI-only</div> : null}
      {milestones.length === 0 ? (
        <div className="roadmap-block-empty">no milestones</div>
      ) : (
        <>
          <div className="roadmap-progress">
            <div className="roadmap-progress-track">
              <div
                className="roadmap-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="roadmap-progress-label">
              {progress.done}/{progress.total} ({progress.percent}%)
            </div>
          </div>
          <div className="roadmap-timeline">
            {sorted.map((m, idx) => {
              const blocked = m.status === 'todo' && m.deps.some((d) => !doneIds.has(d))
              return (
                <div
                  key={m.id}
                  className={`roadmap-milestone status-${m.status}${blocked ? ' is-blocked' : ''}${
                    flashId === m.id ? ' just-changed' : ''
                  }`}
                >
                  {idx > 0 ? <div className="roadmap-connector" /> : null}
                  <button
                    type="button"
                    className="roadmap-status-btn"
                    onClick={() => onClickStatus(m.id)}
                    disabled={readOnly}
                    tabIndex={readOnly ? -1 : 0}
                    title={
                      readOnly
                        ? `Status: ${m.status}${blocked ? ' (deps pendentes)' : ''} — read-only`
                        : `Status: ${m.status}${blocked ? ' (deps pendentes)' : ''} — clique pra alternar`
                    }
                  >
                    <span className="roadmap-status-icon">{statusIcon(m.status, blocked)}</span>
                  </button>
                  <div className="roadmap-milestone-label">{m.label}</div>
                  {m.date ? <div className="roadmap-milestone-date">{formatShortDate(m.date)}</div> : null}
                  {m.deps.length > 0 ? (
                    <div className="roadmap-milestone-deps">
                      ← {m.deps.map((d) => labelById[d] ?? d).join(', ')}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

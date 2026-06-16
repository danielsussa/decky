import { useEffect, useMemo, useRef, useState } from 'react'
import { registerWidget, registerWidgetType } from '../lib/widget-registry'

registerWidgetType({
  type: 'matrix',
  fence: '```matrix',
  description:
    'Weighted decision matrix. Options × criteria with weights; scores 0-10. Computes weighted totals live, highlights the winner.',
  specSchema:
    '{ "id": string, "readonly?": boolean (default false — when true, user can\'t edit cells/weights; AI ops still work), "options": [{ "id", "label" }], "criteria": [{ "id", "label", "weight" (1-10) }], "scores": { "<optionId>.<criterionId>": number 0-10 } }',
  ops: [
    {
      name: 'setScore',
      description: 'Set a single score cell (0-10).',
      args: {
        type: 'object',
        properties: {
          optionId: { type: 'string' },
          criterionId: { type: 'string' },
          value: { type: 'number', description: '0-10' }
        },
        required: ['optionId', 'criterionId', 'value']
      }
    },
    {
      name: 'setWeight',
      description: 'Set a criterion weight (1-10).',
      args: {
        type: 'object',
        properties: {
          criterionId: { type: 'string' },
          weight: { type: 'number' }
        },
        required: ['criterionId', 'weight']
      }
    },
    {
      name: 'addOption',
      description: 'Add an option column.',
      args: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label']
      }
    },
    {
      name: 'removeOption',
      description: 'Remove an option column (and its scores).',
      args: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    },
    {
      name: 'addCriterion',
      description: 'Add a criterion row.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          weight: { type: 'number', default: 3 }
        },
        required: ['id', 'label']
      }
    },
    {
      name: 'removeCriterion',
      description: 'Remove a criterion row (and its scores).',
      args: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  ],
  getters: [
    { name: 'totals', description: 'Map optionId → weighted total' },
    { name: 'ranking', description: 'Array of optionIds sorted high → low by weighted total' },
    { name: 'winner', description: 'Top-ranked optionId (or null if empty)' }
  ]
})

interface MatrixOption {
  id: string
  label: string
}

interface MatrixCriterion {
  id: string
  label: string
  weight: number
}

interface MatrixSpec {
  id?: string
  readonly?: boolean
  options: MatrixOption[]
  criteria: MatrixCriterion[]
  scores: Record<string, number>
}

function cellKey(optionId: string, criterionId: string): string {
  return `${optionId}.${criterionId}`
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 10) return 10
  return Math.round(n * 10) / 10
}

function clampWeight(n: number): number {
  if (!Number.isFinite(n)) return 1
  if (n < 1) return 1
  if (n > 10) return 10
  return Math.round(n)
}

function parseSpec(code: string): { spec: MatrixSpec | null; error: string | null } {
  try {
    const parsed = JSON.parse(code) as Partial<MatrixSpec>
    if (!parsed || !Array.isArray(parsed.options) || !Array.isArray(parsed.criteria)) {
      return { spec: null, error: 'spec needs { options: [...], criteria: [...] }' }
    }
    const options = parsed.options.filter(
      (o): o is MatrixOption =>
        !!o && typeof o.id === 'string' && typeof o.label === 'string'
    )
    const criteria = parsed.criteria
      .filter(
        (c): c is MatrixCriterion =>
          !!c && typeof c.id === 'string' && typeof c.label === 'string'
      )
      .map((c) => ({ ...c, weight: clampWeight(typeof c.weight === 'number' ? c.weight : 3) }))
    const rawScores = (parsed.scores ?? {}) as Record<string, unknown>
    const scores: Record<string, number> = {}
    for (const [k, v] of Object.entries(rawScores)) {
      if (typeof v === 'number') scores[k] = clampScore(v)
    }
    return {
      spec: {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        readonly: parsed.readonly === true,
        options,
        criteria,
        scores
      },
      error: null
    }
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

function computeTotals(
  options: MatrixOption[],
  criteria: MatrixCriterion[],
  scores: Record<string, number>
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const opt of options) {
    let sum = 0
    for (const crit of criteria) {
      const s = scores[cellKey(opt.id, crit.id)] ?? 0
      sum += s * crit.weight
    }
    totals[opt.id] = Math.round(sum * 10) / 10
  }
  return totals
}

interface MatrixBlockProps {
  code: string
  cardId: string
}

export default function MatrixBlock({ code, cardId }: MatrixBlockProps): React.JSX.Element {
  const [debounced, setDebounced] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 80)
    return () => clearTimeout(t)
  }, [code])

  const { spec, error } = useMemo(() => parseSpec(debounced), [debounced])

  const [options, setOptions] = useState<MatrixOption[]>(spec?.options ?? [])
  const [criteria, setCriteria] = useState<MatrixCriterion[]>(spec?.criteria ?? [])
  const [scores, setScores] = useState<Record<string, number>>(spec?.scores ?? {})
  const [flashKey, setFlashKey] = useState<string | null>(null)

  useEffect(() => {
    if (spec) {
      setOptions(spec.options)
      setCriteria(spec.criteria)
      setScores(spec.scores)
    }
  }, [spec])

  const optionsRef = useRef(options)
  const criteriaRef = useRef(criteria)
  const scoresRef = useRef(scores)
  useEffect(() => {
    optionsRef.current = options
  }, [options])
  useEffect(() => {
    criteriaRef.current = criteria
  }, [criteria])
  useEffect(() => {
    scoresRef.current = scores
  }, [scores])

  const flash = (k: string): void => {
    setFlashKey(k)
    setTimeout(() => setFlashKey((cur) => (cur === k ? null : cur)), 600)
  }

  const widgetId = spec?.id
  useEffect(() => {
    if (!cardId || !widgetId) return
    const currentTotals = (): Record<string, number> =>
      computeTotals(optionsRef.current, criteriaRef.current, scoresRef.current)
    const currentRanking = (): string[] => {
      const t = currentTotals()
      return [...optionsRef.current]
        .map((o) => o.id)
        .sort((a, b) => (t[b] ?? 0) - (t[a] ?? 0))
    }
    return registerWidget(cardId, widgetId, {
      type: 'matrix',
      ops: {
        setScore: (args) => {
          const a = (args ?? {}) as { optionId?: string; criterionId?: string; value?: number }
          if (typeof a.optionId !== 'string' || typeof a.criterionId !== 'string')
            throw new Error('setScore: optionId + criterionId required')
          if (typeof a.value !== 'number') throw new Error('setScore: value (number) required')
          const k = cellKey(a.optionId, a.criterionId)
          const v = clampScore(a.value)
          setScores((s) => ({ ...s, [k]: v }))
          flash(k)
          return { ok: true, value: v }
        },
        setWeight: (args) => {
          const a = (args ?? {}) as { criterionId?: string; weight?: number }
          if (typeof a.criterionId !== 'string') throw new Error('setWeight: criterionId required')
          if (typeof a.weight !== 'number') throw new Error('setWeight: weight required')
          const w = clampWeight(a.weight)
          setCriteria((cs) => cs.map((c) => (c.id === a.criterionId ? { ...c, weight: w } : c)))
          flash(`w:${a.criterionId}`)
          return { ok: true, weight: w }
        },
        addOption: (args) => {
          const a = (args ?? {}) as { id?: string; label?: string }
          if (typeof a.id !== 'string' || typeof a.label !== 'string')
            throw new Error('addOption: id + label required')
          setOptions((os) =>
            os.some((o) => o.id === a.id) ? os : [...os, { id: a.id!, label: a.label! }]
          )
          return { ok: true }
        },
        removeOption: (args) => {
          const a = (args ?? {}) as { id?: string }
          if (typeof a.id !== 'string') throw new Error('removeOption: id required')
          setOptions((os) => os.filter((o) => o.id !== a.id))
          setScores((s) => {
            const next: Record<string, number> = {}
            for (const [k, v] of Object.entries(s)) if (!k.startsWith(`${a.id}.`)) next[k] = v
            return next
          })
          return { ok: true }
        },
        addCriterion: (args) => {
          const a = (args ?? {}) as { id?: string; label?: string; weight?: number }
          if (typeof a.id !== 'string' || typeof a.label !== 'string')
            throw new Error('addCriterion: id + label required')
          const w = clampWeight(typeof a.weight === 'number' ? a.weight : 3)
          setCriteria((cs) =>
            cs.some((c) => c.id === a.id) ? cs : [...cs, { id: a.id!, label: a.label!, weight: w }]
          )
          return { ok: true }
        },
        removeCriterion: (args) => {
          const a = (args ?? {}) as { id?: string }
          if (typeof a.id !== 'string') throw new Error('removeCriterion: id required')
          setCriteria((cs) => cs.filter((c) => c.id !== a.id))
          setScores((s) => {
            const next: Record<string, number> = {}
            for (const [k, v] of Object.entries(s)) if (!k.endsWith(`.${a.id}`)) next[k] = v
            return next
          })
          return { ok: true }
        }
      },
      getters: {
        totals: currentTotals,
        ranking: currentRanking,
        winner: () => currentRanking()[0] ?? null
      }
    })
  }, [cardId, widgetId])

  const readOnly = spec?.readonly === true
  const totals = useMemo(() => computeTotals(options, criteria, scores), [options, criteria, scores])
  const ranking = useMemo(
    () => [...options].map((o) => o.id).sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0)),
    [options, totals]
  )
  const winner = ranking[0] ?? null

  const onScoreChange = (optionId: string, criterionId: string, raw: string): void => {
    const k = cellKey(optionId, criterionId)
    if (raw === '') {
      setScores((s) => {
        const { [k]: _drop, ...rest } = s
        void _drop
        return rest
      })
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    setScores((s) => ({ ...s, [k]: clampScore(n) }))
    flash(k)
  }

  const onWeightChange = (criterionId: string, raw: string): void => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    setCriteria((cs) => cs.map((c) => (c.id === criterionId ? { ...c, weight: clampWeight(n) } : c)))
    flash(`w:${criterionId}`)
  }

  return (
    <div className={`matrix-block${readOnly ? ' is-readonly' : ''}`}>
      {error ? <div className="matrix-block-error">matrix: {error}</div> : null}
      {readOnly ? <div className="widget-ai-badge" title="Read-only: só a AI pode mutar via ops">AI-only</div> : null}
      {options.length === 0 || criteria.length === 0 ? (
        <div className="matrix-block-empty">add options + criteria</div>
      ) : (
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="matrix-th-corner">Critério (peso)</th>
              {options.map((o) => (
                <th
                  key={o.id}
                  className={`matrix-th-option${o.id === winner ? ' is-winner' : ''}`}
                >
                  {o.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteria.map((c) => (
              <tr key={c.id}>
                <th className="matrix-th-criterion">
                  <span className="matrix-criterion-label">{c.label}</span>
                  <span
                    className={`matrix-weight${flashKey === `w:${c.id}` ? ' just-changed' : ''}`}
                  >
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      value={c.weight}
                      readOnly={readOnly}
                      tabIndex={readOnly ? -1 : 0}
                      onChange={(e) => !readOnly && onWeightChange(c.id, e.target.value)}
                      aria-label={`peso de ${c.label}`}
                    />
                  </span>
                </th>
                {options.map((o) => {
                  const k = cellKey(o.id, c.id)
                  const v = scores[k]
                  return (
                    <td
                      key={o.id}
                      className={`matrix-cell${flashKey === k ? ' just-changed' : ''}`}
                    >
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.5}
                        value={v ?? ''}
                        placeholder="—"
                        readOnly={readOnly}
                        tabIndex={readOnly ? -1 : 0}
                        onChange={(e) => !readOnly && onScoreChange(o.id, c.id, e.target.value)}
                        aria-label={`nota de ${o.label} em ${c.label}`}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="matrix-th-totals">Score ponderado</th>
              {options.map((o) => (
                <th
                  key={o.id}
                  className={`matrix-total${o.id === winner ? ' is-winner' : ''}`}
                >
                  <span className="matrix-total-value">{totals[o.id]?.toFixed(1) ?? '0.0'}</span>
                  {o.id === winner ? <span className="matrix-trophy">🏆</span> : null}
                </th>
              ))}
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { registerWidget, registerWidgetType } from '../lib/widget-registry'

registerWidgetType({
  type: 'checklist',
  fence: '```checklist',
  description:
    'Interactive task list with custom-styled checkboxes. Users can click to toggle; AI mutates via ops with a purple flash animation on change.',
  specSchema:
    '{ "id": string, "items": [{ "id": string, "label": string (markdown inline ok), "checked?": boolean }] }',
  ops: [
    {
      name: 'toggle',
      description: 'Flip the checked state of one item. Triggers the flash animation.',
      args: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Item id from the spec' } },
        required: ['id']
      }
    },
    {
      name: 'check',
      description: 'Set explicit checked value for one item (default true).',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          checked: { type: 'boolean', default: true }
        },
        required: ['id']
      }
    },
    {
      name: 'setItems',
      description: 'Replace the whole list (use for big restructure).',
      args: {
        type: 'object',
        properties: { items: { type: 'array', description: 'Array of {id, label, checked?} items' } },
        required: ['items']
      }
    }
  ],
  getters: [
    { name: 'items', description: 'Current items array' },
    { name: 'checked', description: 'Array of ids that are currently checked' }
  ]
})

interface ChecklistItem {
  id: string
  label: string
  checked?: boolean
}

interface ChecklistSpec {
  id?: string
  items: ChecklistItem[]
}

function parseSpec(code: string): { spec: ChecklistSpec | null; error: string | null } {
  try {
    const parsed = JSON.parse(code) as Partial<ChecklistSpec>
    if (!parsed || !Array.isArray(parsed.items)) {
      return { spec: null, error: 'spec needs { items: [{ id, label, checked? }] }' }
    }
    const items = parsed.items.filter(
      (it): it is ChecklistItem =>
        !!it && typeof it.id === 'string' && typeof it.label === 'string'
    )
    return {
      spec: {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        items
      },
      error: null
    }
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

interface ChecklistBlockProps {
  code: string
  cardId: string
}

// Same debounce + register-on-mount contract as FlowBlock. Ops:
//   toggle({ id })             — flip
//   check({ id, checked? })    — set explicit value (default true)
//   setItems({ items })        — replace whole list
// Getters:
//   items   — current items
//   checked — array of ids currently checked
export default function ChecklistBlock({ code, cardId }: ChecklistBlockProps): React.JSX.Element {
  const [debounced, setDebounced] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 80)
    return () => clearTimeout(t)
  }, [code])

  const { spec, error } = useMemo(() => parseSpec(debounced), [debounced])

  const [items, setItems] = useState<ChecklistItem[]>(spec?.items ?? [])
  const [recentlyChanged, setRecentlyChanged] = useState<string | null>(null)

  useEffect(() => {
    if (spec) setItems(spec.items)
  }, [spec])

  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const flashChange = (id: string): void => {
    setRecentlyChanged(id)
    setTimeout(() => {
      setRecentlyChanged((cur) => (cur === id ? null : cur))
    }, 600)
  }

  const widgetId = spec?.id
  useEffect(() => {
    if (!cardId || !widgetId) return
    return registerWidget(cardId, widgetId, {
      type: 'checklist',
      ops: {
        toggle: (args) => {
          const a = (args ?? {}) as { id?: string }
          if (typeof a.id !== 'string') throw new Error('toggle: id required')
          setItems((its) =>
            its.map((it) => (it.id === a.id ? { ...it, checked: !it.checked } : it))
          )
          flashChange(a.id)
          return { ok: true }
        },
        check: (args) => {
          const a = (args ?? {}) as { id?: string; checked?: boolean }
          if (typeof a.id !== 'string') throw new Error('check: id required')
          const checked = a.checked !== false
          setItems((its) =>
            its.map((it) => (it.id === a.id ? { ...it, checked } : it))
          )
          flashChange(a.id)
          return { ok: true, checked }
        },
        setItems: (args) => {
          const a = (args ?? {}) as { items?: ChecklistItem[] }
          if (!Array.isArray(a.items)) throw new Error('setItems: items[] required')
          setItems(a.items)
          return { ok: true, count: a.items.length }
        }
      },
      getters: {
        items: () => itemsRef.current,
        checked: () => itemsRef.current.filter((it) => it.checked).map((it) => it.id)
      }
    })
  }, [cardId, widgetId])

  const onToggle = (id: string): void => {
    setItems((its) => its.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it)))
    flashChange(id)
  }

  return (
    <div className="checklist-block">
      {error ? <div className="checklist-block-error">checklist: {error}</div> : null}
      <ul className="checklist-list">
        {items.map((it) => (
          <li
            key={it.id}
            className={`checklist-item${it.checked ? ' is-checked' : ''}${
              recentlyChanged === it.id ? ' just-changed' : ''
            }`}
          >
            <label className="checklist-row">
              <input
                type="checkbox"
                checked={!!it.checked}
                onChange={() => onToggle(it.id)}
              />
              <span className="checklist-label">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  disallowedElements={['p']}
                  unwrapDisallowed
                >
                  {it.label}
                </ReactMarkdown>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

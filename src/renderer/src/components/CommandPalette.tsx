import { useState } from 'react'
import { t } from '../lib/i18n'

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  // Called when the user submits `//<query>` — opens a new web card pointing at a Google
  // search for <query>. If omitted, the `//` shortcut is hidden.
  onWebSearch?: (query: string) => void
}

export default function CommandPalette({
  commands,
  onClose,
  onWebSearch
}: CommandPaletteProps): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const searchMode = onWebSearch && q.startsWith('//')
  const searchQuery = searchMode ? q.slice(2).trim() : ''
  const needle = q.toLowerCase().trim()
  const filtered: Command[] = searchMode
    ? searchQuery
      ? [
          {
            id: 'web:search',
            label: `${t('cmd.googleSearch')}: ${searchQuery}`,
            hint: t('cmd.googleSearchHint'),
            run: () => onWebSearch!(searchQuery)
          }
        ]
      : []
    : commands.filter((c) =>
        `${c.label} ${c.hint ?? ''} ${c.id}`.toLowerCase().includes(needle)
      )

  const run = (c: Command | undefined): void => {
    if (!c) return
    c.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          value={q}
          placeholder={t('palette.placeholder')}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[sel])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && (
            <div className="palette-empty">
              {searchMode ? t('cmd.googleSearchPrompt') : 'nenhum comando'}
            </div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === sel ? 'palette-item-sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="palette-item-label">{c.label}</span>
              {c.hint && <span className="palette-item-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'

interface EditorPreviewProps {
  content: string
  path: string
}

// Minimal text editor: textarea, monospace, Cmd+S saves to disk. The card receives `content`
// from the on-disk file (live-reloaded by the App-level fs watcher). We keep a local buffer
// and only adopt new disk content when the user has no unsaved edits; otherwise a banner
// offers to discard local changes and load the new version.
export default function EditorPreview({ content, path }: EditorPreviewProps): React.JSX.Element {
  const [buffer, setBuffer] = useState(content)
  const [baseline, setBaseline] = useState(content)
  const [justSaved, setJustSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // Ignore the next disk-change for the file we just wrote — our own write echoes back.
  const justSavedRef = useRef<string | null>(null)
  // Tracks the last `content` we acted on. Without this, the effect would re-fire after a
  // save (baseline changed → deps changed) WHILE `content` is still the pre-save value, and
  // the "!dirty → setBuffer(content)" branch would silently revert the save until the file
  // watcher caught up — leaving the editor permanently "não salvo".
  const prevContentRef = useRef(content)

  const dirty = buffer !== baseline
  const diskChangedWhileDirty = dirty && content !== baseline

  // Adopt new disk content as baseline; if the user is clean, also sync the buffer.
  useEffect(() => {
    const prev = prevContentRef.current
    prevContentRef.current = content
    if (content === prev) return // re-fire from baseline/dirty change only — ignore
    if (content === baseline) return
    if (justSavedRef.current === content) {
      justSavedRef.current = null
      setBaseline(content)
      return
    }
    if (!dirty) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBuffer(content)
      setBaseline(content)
    }
    // If dirty, leave buffer alone; the banner reads baseline vs. content to offer "reload".
  }, [content, baseline, dirty])

  const save = useCallback(async (): Promise<void> => {
    const text = buffer
    justSavedRef.current = text
    const ok = await window.deck.file.write(path, text)
    if (ok) {
      setBaseline(text)
      setJustSaved(true)
      setSaveError(null)
    } else {
      justSavedRef.current = null
      setSaveError('falha ao salvar')
    }
  }, [buffer, path])

  // Cmd/Ctrl+S anywhere inside the editor card.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      e.stopPropagation()
      void save()
    }
  }

  const reloadFromDisk = (): void => {
    setBuffer(content)
    setBaseline(content)
  }

  // Auto-focus on first mount so the user can start typing immediately.
  useEffect(() => {
    taRef.current?.focus()
  }, [])

  // Brief "salvo" flash that fades after 1.5s.
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(false), 1500)
    return () => clearTimeout(t)
  }, [justSaved])

  return (
    <div className="editor-preview">
      <div className="editor-bar">
        <span className="editor-path" title={path}>
          {path}
        </span>
        <span className="editor-status">
          {saveError ? (
            <span className="editor-err">{saveError}</span>
          ) : diskChangedWhileDirty ? (
            <button type="button" className="editor-reload" onClick={reloadFromDisk}>
              disco mudou — descartar e recarregar
            </button>
          ) : dirty ? (
            <span className="editor-dirty">● não salvo</span>
          ) : justSaved ? (
            <span className="editor-saved">salvo</span>
          ) : null}
        </span>
        <button type="button" className="editor-save" onClick={() => void save()} disabled={!dirty}>
          {navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl+S'} salvar
        </button>
      </div>
      <textarea
        ref={taRef}
        className="editor-textarea"
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        wrap="off"
      />
    </div>
  )
}

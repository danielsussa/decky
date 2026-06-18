import { useEffect } from 'react'
import { THEMES } from '@decky/shared'
import { bgImagesFor } from '../lib/bg-images'
import { t } from '../lib/i18n'

interface ThemePickerProps {
  // Imagem atualmente fixada no workspace (tema + índice), pra destacar no grid. null = nenhuma
  // pinada (o workspace usa a imagem sorteada por hash do path).
  current: { theme: string; idx: number } | null
  // Fixa a imagem escolhida como background; o workspace passa a usar o TEMA dela.
  onPick: (theme: string, idx: number) => void
  onClose: () => void
}

export default function ThemePicker({
  current,
  onPick,
  onClose
}: ThemePickerProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="theme-picker" onClick={(e) => e.stopPropagation()}>
        <div className="theme-picker-head">
          <span className="theme-picker-title">{t('themePicker.title')}</span>
          <span className="theme-picker-sub">{t('themePicker.sub')}</span>
        </div>
        <div className="theme-picker-body">
          {THEMES.map((th) => {
            const imgs = bgImagesFor(th.id)
            if (imgs.length === 0) return null
            return (
              <section key={th.id} className="theme-picker-group">
                <h3 className="theme-picker-group-name">{th.name}</h3>
                <div className="theme-picker-grid">
                  {imgs.map((url, idx) => {
                    const sel = current?.theme === th.id && current.idx === idx
                    return (
                      <button
                        key={idx}
                        type="button"
                        className={`theme-picker-cell ${sel ? 'is-sel' : ''}`}
                        style={{ backgroundImage: `url("${url}")` }}
                        title={`${th.name} · ${idx}`}
                        onClick={() => {
                          onPick(th.id, idx)
                          onClose()
                        }}
                      >
                        {sel && <span className="theme-picker-check">✓</span>}
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

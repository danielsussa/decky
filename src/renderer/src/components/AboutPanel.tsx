import { useEffect, useState } from 'react'
import { t } from '../lib/i18n'

export interface AboutInfo {
  name: string
  version: string
  sha: string
  date: string
  label: string
}

const REPO_URL = 'https://github.com/danielsussa/decky'

interface AboutPanelProps {
  info: AboutInfo
  onClose: () => void
}

export default function AboutPanel({ info, onClose }: AboutPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

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

  const copyBuild = (): void => {
    void navigator.clipboard.writeText(`${info.name} ${info.version} (${info.label})`).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="about-panel" onClick={(e) => e.stopPropagation()}>
        <div className="about-mark" aria-hidden>
          🃏
        </div>
        <div className="about-name">{info.name}</div>
        <div className="about-tagline">{t('about.tagline')}</div>

        <dl className="about-rows">
          <div className="about-row">
            <dt>{t('about.version')}</dt>
            <dd>{info.version}</dd>
          </div>
          <div className="about-row">
            <dt>{t('about.build')}</dt>
            <dd className="about-mono" title={info.label}>
              {info.label}
            </dd>
          </div>
          <div className="about-row">
            <dt>{t('about.repo')}</dt>
            <dd>
              <a
                className="about-link"
                href={REPO_URL}
                onClick={(e) => {
                  e.preventDefault()
                  void window.deck.app.openExternal(REPO_URL)
                }}
              >
                danielsussa/decky
              </a>
            </dd>
          </div>
        </dl>

        <div className="about-actions">
          <button type="button" className="about-btn" onClick={copyBuild}>
            {copied ? t('about.copied') : t('about.copyBuild')}
          </button>
        </div>

        <div className="about-foot">© {info.date.slice(0, 4)} Daniel Kanczuk</div>
      </div>
    </div>
  )
}

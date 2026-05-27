import { useState } from 'react'
import Terminal from './components/Terminal'

const LIVE_VIEW_DEFAULT = 'http://127.0.0.1:6789'
const TERMINAL_CWD = '/Users/danielkanczuk/Documents/projects/me'

function App(): React.JSX.Element {
  const [liveViewUrl, setLiveViewUrl] = useState(LIVE_VIEW_DEFAULT)
  const [liveViewKey, setLiveViewKey] = useState(0)

  return (
    <div className="deck">
      <header className="deck-titlebar">
        <span className="deck-brand">deck</span>
        <span className="deck-titlebar-spacer" />
      </header>

      <main className="deck-grid">
        <section className="panel panel-terminal">
          <div className="panel-header">
            <span>terminal</span>
            <span className="panel-header-meta">{TERMINAL_CWD.replace(/^.*\//, '')}</span>
          </div>
          <div className="panel-body panel-body-flush">
            <Terminal id="main" cwd={TERMINAL_CWD} />
          </div>
        </section>

        <section className="panel panel-liveview">
          <div className="panel-header">
            <span>live view</span>
            <input
              className="url-input"
              value={liveViewUrl}
              onChange={(e) => setLiveViewUrl(e.target.value)}
              spellCheck={false}
            />
            <button
              className="icon-btn"
              title="recarregar"
              onClick={() => setLiveViewKey((k) => k + 1)}
            >
              ↻
            </button>
          </div>
          <div className="panel-body panel-body-flush">
            <iframe
              key={liveViewKey}
              className="liveview-frame"
              src={liveViewUrl}
              title="me live view"
            />
          </div>
        </section>

        <section className="panel panel-side">
          <div className="panel-header">pendências</div>
          <div className="panel-body panel-placeholder">
            <p>parser de <code>pendencias.md</code> em breve.</p>
            <p className="muted">próximo PR.</p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App

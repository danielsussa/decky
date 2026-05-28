import { useState } from 'react'

interface JsonPreviewProps {
  value: unknown
}

export default function JsonPreview({ value }: JsonPreviewProps): React.JSX.Element {
  return (
    <div className="json-preview">
      <JsonNode value={value} depth={0} keyName="" isRoot />
    </div>
  )
}

interface JsonNodeProps {
  value: unknown
  depth: number
  keyName: string
  isRoot?: boolean
}

function JsonNode({ value, depth, keyName, isRoot }: JsonNodeProps): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2)

  if (value === null) return <Leaf keyName={keyName} value="null" type="null" isRoot={isRoot} />
  if (typeof value === 'string')
    return <Leaf keyName={keyName} value={`"${value}"`} type="string" isRoot={isRoot} />
  if (typeof value === 'number' || typeof value === 'boolean')
    return <Leaf keyName={keyName} value={String(value)} type={typeof value} isRoot={isRoot} />

  if (Array.isArray(value)) {
    return (
      <div className="json-node">
        <span className="json-toggle" onClick={() => setOpen(!open)}>
          <span className="json-caret">{open ? '▾' : '▸'}</span>
          {!isRoot && <span className="json-key">{keyName}:</span>}
          <span className="json-bracket">{open ? '[' : `[ … ${value.length} ]`}</span>
        </span>
        {open && (
          <div className="json-children">
            {value.map((item, i) => (
              <JsonNode key={i} value={item} depth={depth + 1} keyName={String(i)} />
            ))}
            <div className="json-bracket json-close">]</div>
          </div>
        )}
      </div>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      <div className="json-node">
        <span className="json-toggle" onClick={() => setOpen(!open)}>
          <span className="json-caret">{open ? '▾' : '▸'}</span>
          {!isRoot && <span className="json-key">{keyName}:</span>}
          <span className="json-bracket">{open ? '{' : `{ … ${entries.length} }`}</span>
        </span>
        {open && (
          <div className="json-children">
            {entries.map(([k, v]) => (
              <JsonNode key={k} value={v} depth={depth + 1} keyName={k} />
            ))}
            <div className="json-bracket json-close">{'}'}</div>
          </div>
        )}
      </div>
    )
  }

  return <Leaf keyName={keyName} value={String(value)} type="unknown" isRoot={isRoot} />
}

function Leaf({
  keyName,
  value,
  type,
  isRoot
}: {
  keyName: string
  value: string
  type: string
  isRoot?: boolean
}): React.JSX.Element {
  return (
    <div className="json-leaf">
      {!isRoot && <span className="json-key">{keyName}:</span>}
      <span className={`json-value json-value-${type}`}>{value}</span>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { registerWidget, registerWidgetType } from '../lib/widget-registry'

registerWidgetType({
  type: 'flow',
  fence: '```flow',
  description:
    'Interactive React Flow diagram (nodes + edges). Supports drag/connect by the user and imperative mutation by the AI.',
  specSchema:
    '{ "id": string, "nodes": [{ "id", "type": "decky", "position": {x,y}, "data": { "title", "body?", "tone": "info|ok|warn|bad", "active?" } }], "edges": [{ "id", "source", "target", "label?", "animated?" }] }',
  ops: [
    {
      name: 'setActive',
      description: 'Set a node as active (pulses + shimmer + glow). Pass active:false to clear.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id from the spec' },
          active: { type: 'boolean', description: 'Default true', default: true }
        },
        required: ['id']
      }
    },
    {
      name: 'pulseFor',
      description: 'Temporarily activate a node for N ms, then deactivate. Async — resolves after ms elapses.',
      args: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ms: { type: 'number', description: 'Duration in ms (default 2000)', default: 2000 }
        },
        required: ['id']
      }
    },
    {
      name: 'setNodes',
      description: 'Replace ALL nodes. Use for layout changes / full graph swaps.',
      args: {
        type: 'object',
        properties: { nodes: { type: 'array', description: 'Array of Node objects' } },
        required: ['nodes']
      }
    },
    {
      name: 'setEdges',
      description: 'Replace ALL edges.',
      args: {
        type: 'object',
        properties: { edges: { type: 'array' } },
        required: ['edges']
      }
    }
  ],
  getters: [
    { name: 'nodes', description: 'Current nodes array (including user drags / AI mutations)' },
    { name: 'edges', description: 'Current edges array' },
    {
      name: 'positions',
      description: 'Object map nodeId → {x,y} — useful to pick up where the user dragged nodes to'
    }
  ]
})

interface FlowSpec {
  id?: string
  nodes: Node[]
  edges: Edge[]
}

function DeckyNode({ data }: NodeProps): React.JSX.Element {
  const d = data as {
    title?: string
    body?: string
    tone?: 'ok' | 'warn' | 'bad' | 'info'
    active?: boolean
  }
  const tone = d.tone ?? 'info'
  const active = Boolean(d.active)
  return (
    <div className={`flow-decky-node tone-${tone}${active ? ' is-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-decky-node-title">
        {d.title ?? 'Node'}
        {active ? <span className="flow-decky-node-badge">● running</span> : null}
      </div>
      {d.body ? <div className="flow-decky-node-body">{d.body}</div> : null}
      {active ? <div className="flow-decky-node-shimmer" /> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { decky: DeckyNode }

const EMPTY: FlowSpec = { nodes: [], edges: [] }

function parseSpec(code: string): { spec: FlowSpec | null; error: string | null } {
  try {
    const parsed = JSON.parse(code) as Partial<FlowSpec>
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return { spec: null, error: 'spec needs { nodes: [], edges: [] }' }
    }
    return {
      spec: {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        nodes: parsed.nodes,
        edges: parsed.edges
      },
      error: null
    }
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

interface FlowBlockProps {
  code: string
  cardId: string
}

// MarkdownPreview streams content char-by-char, so this component is called with truncated JSON
// for ~700ms on first render. Debounce parsing and only swap in a new spec once parse succeeds —
// avoids flicker AND keeps user-positioned nodes alive while they're editing the source.
//
// If the parsed spec has an `id`, this widget registers itself with the widget registry so the
// AI can drive it imperatively via MCP card_invoke/card_get (see lib/widget-registry.ts).
export default function FlowBlock({ code, cardId }: FlowBlockProps): React.JSX.Element {
  const [debounced, setDebounced] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 80)
    return () => clearTimeout(t)
  }, [code])

  const { spec, error } = useMemo(() => parseSpec(debounced), [debounced])

  const [nodes, setNodes] = useState<Node[]>(spec?.nodes ?? EMPTY.nodes)
  const [edges, setEdges] = useState<Edge[]>(spec?.edges ?? EMPTY.edges)

  // Sync state from spec ONLY when parsing succeeded — drop transient errors so we keep showing
  // the last good graph (and any drag positions) while the user is mid-edit.
  useEffect(() => {
    if (spec) {
      setNodes(spec.nodes)
      setEdges(spec.edges)
    }
  }, [spec])

  // Mirror state in refs so widget getters see fresh values without closing over stale state.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  const widgetId = spec?.id
  useEffect(() => {
    if (!cardId || !widgetId) return
    const setActive = (id: string, active: boolean): void => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, active } } : n
        )
      )
    }
    return registerWidget(cardId, widgetId, {
      type: 'flow',
      ops: {
        setActive: (args) => {
          const a = (args ?? {}) as { id?: string; active?: boolean }
          if (typeof a.id !== 'string') throw new Error('setActive: id required')
          setActive(a.id, a.active !== false)
          return { ok: true }
        },
        pulseFor: async (args) => {
          const a = (args ?? {}) as { id?: string; ms?: number }
          if (typeof a.id !== 'string') throw new Error('pulseFor: id required')
          const ms = typeof a.ms === 'number' && a.ms > 0 ? a.ms : 2000
          setActive(a.id, true)
          await new Promise((r) => setTimeout(r, ms))
          setActive(a.id, false)
          return { ok: true, ms }
        },
        setNodes: (args) => {
          const a = (args ?? {}) as { nodes?: Node[] }
          if (!Array.isArray(a.nodes)) throw new Error('setNodes: nodes[] required')
          setNodes(a.nodes)
          return { ok: true, count: a.nodes.length }
        },
        setEdges: (args) => {
          const a = (args ?? {}) as { edges?: Edge[] }
          if (!Array.isArray(a.edges)) throw new Error('setEdges: edges[] required')
          setEdges(a.edges)
          return { ok: true, count: a.edges.length }
        }
      },
      getters: {
        nodes: () => nodesRef.current,
        edges: () => edgesRef.current,
        positions: () =>
          Object.fromEntries(nodesRef.current.map((n) => [n.id, n.position]))
      }
    })
  }, [cardId, widgetId])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [setNodes]
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [setEdges]
  )
  const onConnect = useCallback(
    (conn: Connection) => setEdges((eds) => addEdge(conn, eds)),
    [setEdges]
  )

  return (
    <div className="flow-block">
      {error ? <div className="flow-block-error">flow: {error}</div> : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  )
}

// "Controlando" tracker: debounce ON/OFF do estado "agente está dirigindo este card".
// Compartilhado entre dois caminhos que dirigem o card focado:
//  - handoff backend (socket /tmp/handoff-decky-<sessionId>.sock, usado pelo CLI/SDK/MCP do handoff)
//  - preview server (/web/act HTTP, usado pelo MCP do decky bin/dky-mcp)
//
// Puro — sem Electron API. Quando o estado muda (depois do debounce), o tracker invoca um
// callback registrado por `setControlChangeHandler`. O shim Electron registra esse callback
// pra repassar pra um WebContentsView.setControlling (que liga a borda animada + bloqueia
// input humano). Sem callback registrado, o tracker ainda mantém o estado interno
// corretamente — útil pra modo headless/teste.

// Comandos do handoff vêm em rajada — mas com pausas LONGAS entre tool calls de uma IA (ela
// pensa 2-5s entre snapshot e o próximo click). Um debounce curto faria a borda piscar a
// cada tool call. Mantém ligado por esse tempo após o último 'end' — cobre tanto rajadas
// apertadas (CLI/script) quanto sequências espaçadas pelo "raciocínio" da IA. Trade-off:
// quando a IA realmente termina, a UI fica ~5s sem aceitar input humano. Aceitável.
const CONTROL_OFF_DEBOUNCE_MS = 5000

type OnControlChange = (cardId: string, isControlling: boolean) => void
let onChange: OnControlChange | null = null

let controlledCardId: string | null = null
let offTimer: NodeJS.Timeout | null = null
let activeStartedAt = 0
let activeOrigin: string | null = null

// Log compacto pra investigar "borda laranja apareceu sem motivo": cada start/end registra
// origem (handoff-socket vs mcp-http) e cmd. Grepa por "[control-tracker]" no log.
function alog(msg: string): void {
  console.log(`[control-tracker] ${msg}`)
}

export function setControlChangeHandler(fn: OnControlChange | null): void {
  onChange = fn
}

// Marca o início de um comando ativo no `cardId`. Cancela qualquer debounce de OFF em
// andamento. `origin` é uma string curta tipo "handoff-socket:click" ou "mcp-http:navigate"
// pra rastrear quem disparou.
export function trackControlStart(cardId: string, origin = 'unknown'): void {
  if (offTimer) {
    clearTimeout(offTimer)
    offTimer = null
  }
  if (controlledCardId && controlledCardId !== cardId) {
    // Mudou de alvo: desliga o anterior já.
    alog(`switch ${controlledCardId} → ${cardId} (origin=${origin})`)
    onChange?.(controlledCardId, false)
  }
  const wasControlling = controlledCardId === cardId
  controlledCardId = cardId
  activeOrigin = origin
  if (!wasControlling) {
    activeStartedAt = Date.now()
    alog(`start cardId=${cardId} origin=${origin}`)
  }
  onChange?.(cardId, true)
}

// Marca o fim de um comando ativo. Arma um timer pra desligar — se outro start chegar
// antes, o timer é cancelado.
export function trackControlEnd(): void {
  if (offTimer) clearTimeout(offTimer)
  offTimer = setTimeout(() => {
    offTimer = null
    const cardId = controlledCardId
    const origin = activeOrigin
    const elapsed = activeStartedAt ? Date.now() - activeStartedAt : 0
    controlledCardId = null
    activeOrigin = null
    activeStartedAt = 0
    if (cardId) {
      alog(`end cardId=${cardId} origin=${origin ?? '?'} elapsed=${elapsed}ms`)
      onChange?.(cardId, false)
    }
  }, CONTROL_OFF_DEBOUNCE_MS)
}

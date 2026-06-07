// "Controlando" tracker: debounced ON/OFF do estado "agente está dirigindo este card",
// compartilhado entre os dois caminhos que dirigem o WebContents do card focado:
//  - handoff-backend.ts (socket /tmp/handoff-decky.sock, usado pelo CLI/SDK/MCP do handoff)
//  - preview-server.ts (/web/act HTTP, usado pelo MCP nativo do decky bin/dky-mcp)
// Ambos têm que disparar pra UI ligar a borda animada + bloquear input humano, então a
// lógica de start/end com debounce vive aqui, num único lugar.
import type { WebContents } from 'electron'
import { getWebViewsManager } from './web-views'

// Comandos do handoff vêm em rajada — mas com pausas LONGAS entre tool calls de uma IA
// (ela pensa 2-5s entre snapshot e o próximo click). Um debounce curto faria a borda piscar
// a cada tool call. Mantém ligado por esse tempo após o último 'end' — cobre tanto rajadas
// apertadas (CLI/script) quanto sequências espaçadas pelo "raciocínio" da IA. Trade-off:
// quando a IA realmente termina, a UI fica ~5s sem aceitar input humano. Aceitável: é o
// tempo de a pessoa perceber que terminou e voltar a interagir.
const CONTROL_OFF_DEBOUNCE_MS = 5000

let controlledCardId: string | null = null
let offTimer: NodeJS.Timeout | null = null

// Marca o início de um comando ativo dirigindo `wc`. Cancela qualquer debounce de OFF em
// andamento, mapeia WC → cardId e liga setControlling no manager (que injeta o blocker e
// emite IPC pra renderer animar).
export function trackActivityStart(wc: WebContents | null): void {
  const manager = getWebViewsManager()
  if (!manager || !wc) return
  if (offTimer) {
    clearTimeout(offTimer)
    offTimer = null
  }
  const cardId = manager.cardIdFor(wc)
  if (!cardId) return
  if (controlledCardId && controlledCardId !== cardId) {
    // Mudou de alvo (defensivo — sticky deveria evitar): desliga o anterior já.
    manager.setControlling(controlledCardId, false)
  }
  controlledCardId = cardId
  manager.setControlling(cardId, true)
}

// Marca o fim de um comando ativo. Arma um timer pra desligar — se outro start chegar
// antes, o timer é cancelado.
export function trackActivityEnd(): void {
  if (offTimer) clearTimeout(offTimer)
  offTimer = setTimeout(() => {
    offTimer = null
    const cardId = controlledCardId
    controlledCardId = null
    if (cardId) {
      const m = getWebViewsManager()
      if (m) m.setControlling(cardId, false)
    }
  }, CONTROL_OFF_DEBOUNCE_MS)
}

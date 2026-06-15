// Engine model — o decky fala com N engines ao mesmo tempo: o `local` (server embarcado,
// sempre presente) + cada `server` remoto adicionado via "Add server". Cada workspace/session
// pertence a UM engine; a árvore agrupa por KIND(local|server) ▸ WS ▸ SESSION. Antes disso o
// engine era global (local OU remoto) e adicionar um server escondia tudo do local.

export type EngineKind = 'local' | 'server'

export interface Engine {
  /** Estável e único. 'local' para o embarcado; derivado do host para servers. */
  id: string
  kind: EngineKind
  /** Rótulo curto na árvore (ex: 'local', 'pi@raspberry'). */
  label: string
  /** ws://… — loopback pro local, ws://127.0.0.1:<tunnelPort> pro server (túnel SSH). */
  url: string
  /** Bearer token do server remoto. Ausente no local (loopback sem auth). */
  token?: string
  /** Server only: host SSH + caminho do workspace no host remoto, pra re-abrir o túnel no boot. */
  sshHost?: string
  sshIdentity?: string
  remotePath?: string
}

/** Apenas os campos persistidos no state.json (`engines`). O `local` é runtime, não persiste. */
export type ServerEngineConfig = Omit<Engine, 'kind' | 'url'> & {
  kind: 'server'
  /** URL pode mudar a cada boot (porta de túnel nova); persiste o que dá, re-resolve no boot. */
  url?: string
}

export const LOCAL_ENGINE_ID = 'local'

/** argv que o main passa pro preload com a lista de engines (JSON URI-encoded — sem espaço/quote). */
export const ENGINES_ARG_PREFIX = '--decky-engines='

export function serializeEngines(engines: Engine[]): string {
  // encodeURIComponent (browser-safe, sem Buffer) garante que o valor não tenha espaço/aspas
  // que quebrem o argv. Mantém o módulo na superfície browser-safe do @decky/shared.
  return ENGINES_ARG_PREFIX + encodeURIComponent(JSON.stringify(engines))
}

export function parseEnginesArg(arg: string): Engine[] {
  const raw = arg.startsWith(ENGINES_ARG_PREFIX) ? arg.slice(ENGINES_ARG_PREFIX.length) : arg
  if (!raw) return []
  try {
    const parsed = JSON.parse(decodeURIComponent(raw))
    return Array.isArray(parsed) ? (parsed as Engine[]) : []
  } catch {
    return []
  }
}

/** engineId efetivo de um record que pode ou não ter o campo (ausente = local — legado). */
export function engineIdOf(rec: { engineId?: string } | null | undefined): string {
  return rec?.engineId || LOCAL_ENGINE_ID
}

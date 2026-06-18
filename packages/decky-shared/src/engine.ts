// Engine model — a camada de transporte do decky. Hoje existe um único engine, o `local`
// (server embarcado no Electron, loopback WS, sempre presente). A abstração sobrevive porque é
// o próprio transporte: o preload fala com o engine via WS e o main passa a URL do loopback
// pelo argv. (O modo standalone/remoto via SSH foi removido.)

export type EngineKind = 'local'

export interface Engine {
  /** Estável e único. Sempre 'local' hoje. */
  id: string
  kind: EngineKind
  /** Rótulo curto. */
  label: string
  /** ws://… loopback do server embarcado. */
  url: string
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

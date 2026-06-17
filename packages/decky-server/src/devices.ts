import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Diretório de persistência (devices.json). $DECKY_SERVER_DIR override, default ~/.decky-server.
function serverDir(): string {
  return process.env.DECKY_SERVER_DIR || join(homedir(), '.decky-server')
}

// Device-based auth: cada device tem cookie persistente, aprovado por um device JÁ autorizado.
// Substitui o token compartilhado do flow inicial — o admin-token continua existindo, mas só
// pra bootstrap (primeiro device) e recovery. Persistido em devices.json.
//
// Estados:
//   - Approved: device com cookie válido. Pode conectar WS, listar/aprovar/revogar outros.
//   - Pending: device tentou pareamento, espera approval. Mostra o `code` pro user comparar
//     visualmente no admin antes de aprovar (evita aprovar um device errado).

export interface Device {
  id: string
  name: string
  userAgent: string
  ip: string
  createdAt: string
  lastSeenAt: string
}

export interface PendingDevice {
  id: string
  code: string
  userAgent: string
  ip: string
  createdAt: string
  expiresAt: string
}

interface DevicesStore {
  approved: Device[]
  pending: PendingDevice[]
}

const PENDING_TTL_MS = 10 * 60 * 1000 // 10min — humano aprova/reaplica dentro disso
const FILE = 'devices.json'

let cached: DevicesStore | null = null
const writeChains = new Map<string, Promise<void>>()
// reqId → resolver (long-poll wait-pairing). Resolvidos quando aprovados ou rejeitados.
type Resolver = (status: 'approved' | 'rejected' | 'expired') => void
const pendingWaiters = new Map<string, Set<Resolver>>()

function devicesPath(): string {
  return join(serverDir(), FILE)
}

async function load(): Promise<DevicesStore> {
  if (cached) return cached
  try {
    const raw = await readFile(devicesPath(), 'utf-8')
    const parsed = JSON.parse(raw) as DevicesStore
    cached = {
      approved: Array.isArray(parsed.approved) ? parsed.approved : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : []
    }
  } catch {
    cached = { approved: [], pending: [] }
  }
  return cached
}

async function save(): Promise<void> {
  if (!cached) return
  const dest = devicesPath()
  const prev = writeChains.get(dest) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await mkdir(dirname(dest), { recursive: true })
      const tmp = dest + '.tmp'
      await writeFile(tmp, JSON.stringify(cached, null, 2))
      await rename(tmp, dest)
    })
    .catch((err) => {
      console.error('[devices] save failed:', err)
    })
  writeChains.set(dest, next)
  await next
}

function generateDeviceId(): string {
  return 'dev-' + randomBytes(9).toString('base64url')
}

function generatePairingCode(): string {
  // 4 caracteres alfanum sem ambiguidade (sem O/0/I/1/L) — pro user comparar visualmente.
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let out = ''
  const bytes = randomBytes(4)
  for (let i = 0; i < 4; i++) out += ALPHA[bytes[i] % ALPHA.length]
  return out
}

function pruneExpired(store: DevicesStore, now: number): boolean {
  let changed = false
  const kept: PendingDevice[] = []
  for (const p of store.pending) {
    if (new Date(p.expiresAt).getTime() < now) {
      changed = true
      // Notifica waiters que esse pending expirou.
      const waiters = pendingWaiters.get(p.id)
      if (waiters) {
        for (const r of waiters) r('expired')
        pendingWaiters.delete(p.id)
      }
    } else {
      kept.push(p)
    }
  }
  if (changed) store.pending = kept
  return changed
}

/** Cria um pending device. Se já existe pending pro mesmo cookie/UA/IP, reusa. */
export async function requestPairing(info: {
  ip: string
  userAgent: string
  existingPendingId?: string
}): Promise<PendingDevice> {
  const store = await load()
  const now = Date.now()
  if (pruneExpired(store, now)) await save()

  if (info.existingPendingId) {
    const exists = store.pending.find((p) => p.id === info.existingPendingId)
    if (exists) return exists
  }

  const pending: PendingDevice = {
    id: generateDeviceId(),
    code: generatePairingCode(),
    userAgent: info.userAgent || 'unknown',
    ip: info.ip || 'unknown',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_TTL_MS).toISOString()
  }
  store.pending.push(pending)
  await save()
  return pending
}

/** Move um pending pra approved + resolve waiters. Retorna o device aprovado ou null se já não existe. */
export async function approvePending(pendingId: string, name?: string): Promise<Device | null> {
  const store = await load()
  const idx = store.pending.findIndex((p) => p.id === pendingId)
  if (idx < 0) return null
  const p = store.pending[idx]
  const device: Device = {
    id: p.id,
    name: name || guessName(p.userAgent),
    userAgent: p.userAgent,
    ip: p.ip,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  }
  store.pending.splice(idx, 1)
  store.approved.push(device)
  await save()
  const waiters = pendingWaiters.get(pendingId)
  if (waiters) {
    for (const r of waiters) r('approved')
    pendingWaiters.delete(pendingId)
  }
  return device
}

export async function rejectPending(pendingId: string): Promise<boolean> {
  const store = await load()
  const idx = store.pending.findIndex((p) => p.id === pendingId)
  if (idx < 0) return false
  store.pending.splice(idx, 1)
  await save()
  const waiters = pendingWaiters.get(pendingId)
  if (waiters) {
    for (const r of waiters) r('rejected')
    pendingWaiters.delete(pendingId)
  }
  return true
}

export async function revokeDevice(deviceId: string): Promise<boolean> {
  const store = await load()
  const idx = store.approved.findIndex((d) => d.id === deviceId)
  if (idx < 0) return false
  store.approved.splice(idx, 1)
  await save()
  return true
}

export async function findApprovedById(deviceId: string): Promise<Device | null> {
  const store = await load()
  return store.approved.find((d) => d.id === deviceId) ?? null
}

export async function touchLastSeen(deviceId: string): Promise<void> {
  const store = await load()
  const d = store.approved.find((x) => x.id === deviceId)
  if (!d) return
  d.lastSeenAt = new Date().toISOString()
  await save()
}

export async function listAll(): Promise<DevicesStore> {
  const store = await load()
  const now = Date.now()
  if (pruneExpired(store, now)) await save()
  return { approved: [...store.approved], pending: [...store.pending] }
}

/** Bootstrap: cria approved direto sem passar por pending. Usado quando vem com admin-token. */
export async function bootstrapApprove(info: { ip: string; userAgent: string }): Promise<Device> {
  const store = await load()
  const device: Device = {
    id: generateDeviceId(),
    name: guessName(info.userAgent) + ' (bootstrap)',
    userAgent: info.userAgent || 'unknown',
    ip: info.ip || 'unknown',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  }
  store.approved.push(device)
  await save()
  return device
}

/** Promise pra long-poll wait-pairing. Resolve quando approved/rejected/expired. */
export function waitForPairing(
  pendingId: string,
  timeoutMs = 30_000
): Promise<'approved' | 'rejected' | 'expired' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const set = pendingWaiters.get(pendingId)
      if (set) {
        set.delete(resolver)
        if (set.size === 0) pendingWaiters.delete(pendingId)
      }
      resolve('timeout')
    }, timeoutMs)
    const resolver: Resolver = (status) => {
      clearTimeout(timer)
      resolve(status)
    }
    let set = pendingWaiters.get(pendingId)
    if (!set) {
      set = new Set()
      pendingWaiters.set(pendingId, set)
    }
    set.add(resolver)
  })
}

function guessName(ua: string): string {
  // Heurística simples. UA real é guardado integralmente; o name é só rótulo amigável.
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Macintosh/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Device'
}

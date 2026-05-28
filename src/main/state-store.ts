import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { deckStateDir } from './paths'

const STATE_DIR = deckStateDir()
const STATE_PATH = join(STATE_DIR, 'state.json')

type State = Record<string, unknown>

let cached: State | null = null
let writeChain: Promise<void> = Promise.resolve()

async function load(): Promise<State> {
  if (cached) return cached
  try {
    const text = await readFile(STATE_PATH, 'utf-8')
    cached = JSON.parse(text) as State
  } catch {
    cached = {}
  }
  return cached
}

async function persist(): Promise<void> {
  if (!cached) return
  await mkdir(STATE_DIR, { recursive: true })
  const tmp = STATE_PATH + '.tmp'
  await writeFile(tmp, JSON.stringify(cached, null, 2))
  await rename(tmp, STATE_PATH)
}

export function registerStateHandlers(): void {
  ipcMain.handle('state:get', async (_e, key: string) => {
    const state = await load()
    return state[key] ?? null
  })

  ipcMain.handle('state:set', async (_e, key: string, value: unknown) => {
    const state = await load()
    if (value === null || value === undefined) {
      delete state[key]
    } else {
      state[key] = value
    }
    // Serialize writes to avoid clobbering when multiple set() calls race.
    writeChain = writeChain.then(persist).catch((err) => {
      console.error('[state-store] persist failed:', err)
    })
    await writeChain
    return true
  })

  ipcMain.handle('state:get-all', async () => {
    return await load()
  })
}

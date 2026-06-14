import { app } from 'electron'
import { openHistoryDb, closeHistoryDb, historyDbPath } from '@decky/server'
import { flushAll as flushOpenVisits } from '@decky/server'
import { registerHistoryIpc } from '@decky/server'
import { diag } from '@decky/server'

// Boot the history subsystem: opens the global SQLite DB, registers IPC, wires graceful
// shutdown so any in-flight dwell timers are flushed before the DB closes. Called once from
// src/main/index.ts during whenReady.
export function setupHistory(): void {
  try {
    openHistoryDb()
    diag(`[history] db opened at ${historyDbPath()}`)
  } catch (err) {
    console.error('[history] failed to open db:', err)
    return
  }
  registerHistoryIpc()
  app.on('before-quit', () => {
    try {
      flushOpenVisits()
    } catch (err) {
      console.error('[history] flush on quit failed:', err)
    }
    closeHistoryDb()
  })
}

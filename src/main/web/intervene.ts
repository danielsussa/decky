// Human-handoff for web cards. In handoff, a block/captcha fires a macOS banner pointing at the
// separate Live View URL. In decky there's no separate Live View — the web card IS visible in the
// panel — so "hand off to the human" just means: bring decky to the front and log it, so the user
// notices the challenge sitting in the tab they're already looking at and solves it in place.

import type { BrowserWindow } from 'electron'
import { diag } from '@decky/server'

export function focusForIntervention(getWindow: () => BrowserWindow | null, reason: string): void {
  diag(`[web/intervene] ${reason} — bringing decky to front for human intervention`)
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch {
    // best-effort
  }
}

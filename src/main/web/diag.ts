// Stealth diagnostic — open a known bot-detection page (bot.sannysoft.com by default) and scrape
// each check as structured pass/fail. Ported from handoff sdk/diag.ts. Lets us MEASURE what the
// stealth preload (resources/webview-preload.js) actually defeats, so tuning it isn't guesswork.
// The scrape is defensive (walks all table rows, no hard-coded selectors).

import type { WebContents } from 'electron'
import { settle } from './facilitators'

const SCRAPE_JS = `(() => {
  const out = [];
  const rows = document.querySelectorAll('table tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const name = (cells[0].innerText || '').trim();
    if (!name) continue;
    const valueCell = cells[cells.length - 1];
    const value = (valueCell.innerText || '').trim();
    let status = 'unknown';
    const cls = (valueCell.className || '').toLowerCase();
    const color = (valueCell.style.color || '').toLowerCase();
    const bg = (valueCell.style.background || valueCell.style.backgroundColor || '').toLowerCase();
    if (/\\bpassed\\b|\\bpresent\\b|\\bok\\b/.test(cls)) status = 'passed';
    else if (/\\bfailed\\b|\\bmissing\\b|\\berror\\b/.test(cls)) status = 'failed';
    else if (color === 'green' || /green/.test(bg)) status = 'passed';
    else if (color === 'red' || /red/.test(bg)) status = 'failed';
    else if (/^passed$/i.test(value)) status = 'passed';
    else if (/^(failed|missing)$/i.test(value)) status = 'failed';
    out.push({ name, value, status });
  }
  return out;
})()`

export interface DiagCheck {
  name: string
  value: string
  status: 'passed' | 'failed' | 'unknown'
}

export interface DiagReport {
  source: string
  url: string
  ua: string
  totals: { passed: number; failed: number; unknown: number }
  checks: DiagCheck[]
}

// Navigate to the fingerprint target, let async tests populate, scrape the results. Drives the card's
// WebContents (loadURL + settle + an extra wait for async checks). Ref: handoff runDiag.
export async function runDiag(
  wc: WebContents,
  opts: { url?: string; settleMs?: number } = {}
): Promise<DiagReport> {
  const url = opts.url ?? 'https://bot.sannysoft.com/'
  await wc.loadURL(url).catch(() => {})
  await settle(wc)
  // bot.sannysoft.com runs async checks after load; give them a beat to populate.
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 3500))
  const checks = (await wc.executeJavaScript(SCRAPE_JS)) as DiagCheck[]
  const ua = (await wc.executeJavaScript('navigator.userAgent')) as string
  const totals = { passed: 0, failed: 0, unknown: 0 }
  for (const c of checks) totals[c.status]++
  return { source: new URL(url).host, url: wc.getURL(), ua, totals, checks }
}

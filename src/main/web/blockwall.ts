// Anti-bot "block wall" primitive (Akamai / Cloudflare / PerimeterX / DataDome). Sibling of
// captcha.ts: a captcha is a *challenge* a human can solve; a block wall is a *denial* page (HTTP
// 403 "Access Denied", "you have been blocked", "unusual traffic") with nothing to solve — you can
// only back off, vary the rhythm and retry, or hand off to the human.
//
// Ported from handoff sdk/blockwall.ts. navigateResilient drives an Electron WebContents
// (wc.loadURL + settle) instead of the Playwright daemon, and on exhaustion returns a structured
// result (ok:false + BlockInfo) so the CLI can print it; the caller focuses decky for intervention.

import type { WebContents } from 'electron'
import { settle, waitUntil } from './facilitators'

// JS evaluated in the page to detect a block wall. Returns a short descriptor when blocked, or null
// when the page looks clean.
const DETECT_JS = `(() => {
  const title = (document.title || '').trim();
  const body = (document.body ? (document.body.innerText || '') : '').slice(0, 6000);
  const u = location.href;
  if (/^Access Denied$/i.test(title)) return 'akamai:access-denied';
  if (/You don'?t have permission to access/i.test(body) && /Reference\\s*#?\\s*[\\w.]+/i.test(body)) return 'akamai:reference';
  if (/Sorry, you have been blocked/i.test(body)) return 'cloudflare:blocked';
  if (/Cloudflare/i.test(body) && /(Error\\s*10\\d\\d|Ray ID)/i.test(body)) return 'cloudflare:error';
  if (/PerimeterX|px-captcha|_px[A-Z]?\\b/i.test(body)) return 'perimeterx';
  if (/datadome/i.test(body) || /datadome/i.test(u)) return 'datadome';
  if (/unusual traffic|automated (requests|queries)|verify you are (a )?human/i.test(body)) return 'generic:verify';
  if (/^(403 Forbidden|Forbidden)$/i.test(title)) return 'http:403';
  return null;
})()`

export interface BlockInfo {
  descriptor: string
  title: string
  url: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const jitter = (max: number): number => Math.floor(Math.random() * max)

// Detect once. Returns descriptor or null. Swallows eval errors.
export async function detectBlock(wc: WebContents): Promise<string | null> {
  try {
    const r = (await wc.executeJavaScript(DETECT_JS)) as string | null
    return r ?? null
  } catch {
    return null
  }
}

async function pageInfo(wc: WebContents): Promise<{ title: string; url: string }> {
  try {
    return (await wc.executeJavaScript(
      `({ title: document.title || '', url: location.href })`
    )) as { title: string; url: string }
  } catch {
    return { title: '', url: '' }
  }
}

export interface ResilientNavOpts {
  // URL to "warm up" before the target (typically the site home) — seeds the WAF sensor cookie on a
  // light page before hitting the expensive resource. Re-warms on each retry.
  warmUp?: string
  warmUpSettleMs?: number
  retries?: number // total attempts (incl. the first). Default 3.
  backoffMs?: number // base backoff, grows linearly × attempt. Default 4000.
  jitterMs?: number // random 0..jitterMs added before each navigate. Default 900.
  readyExpr?: string // optional JS expression to waitUntil after a clean load.
  readyTimeoutMs?: number
}

export interface ResilientNavResult {
  ok: boolean
  url: string
  title: string
  attempts: number
  blocked?: BlockInfo
}

// Navigate to `url` resisting anti-bot walls: human jitter, optional warm-up, settle, and retry with
// backoff. Returns ok:true with the final page when clean; ok:false + the last BlockInfo if it stays
// blocked after all attempts. Not a guaranteed bypass — aggressive Akamai/DataDome can still win.
export async function navigateResilient(
  wc: WebContents,
  url: string,
  opts: ResilientNavOpts = {}
): Promise<ResilientNavResult> {
  const retries = opts.retries ?? 3
  const backoffMs = opts.backoffMs ?? 4000
  const jitterMs = opts.jitterMs ?? 900
  let last: BlockInfo | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (opts.warmUp) {
      await sleep(jitter(jitterMs))
      await wc.loadURL(opts.warmUp).catch(() => {})
      await settle(wc, { timeoutMs: opts.warmUpSettleMs ?? 1500 })
    }
    await sleep(jitter(jitterMs))
    await wc.loadURL(url).catch(() => {})
    await settle(wc)

    const desc = await detectBlock(wc)
    if (!desc) {
      if (opts.readyExpr) {
        await waitUntil(wc, opts.readyExpr, { timeoutMs: opts.readyTimeoutMs ?? 12000 }).catch(
          () => {}
        )
      }
      const info = await pageInfo(wc)
      return { ok: true, url: info.url, title: info.title, attempts: attempt }
    }
    last = { descriptor: desc, ...(await pageInfo(wc)) }
    if (attempt < retries) {
      // Growing backoff + jitter: lets the WAF's IP flag relax before the next try.
      await sleep(backoffMs * attempt + jitter(jitterMs))
    }
  }
  return {
    ok: false,
    url: last?.url ?? url,
    title: last?.title ?? '',
    attempts: retries,
    blocked: last ?? { descriptor: 'unknown', title: '', url }
  }
}

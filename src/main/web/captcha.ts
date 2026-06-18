// CAPTCHA / challenge detection + human handoff. Ported from handoff sdk/captcha.ts. A captcha is a
// challenge a human can solve (unlike a block wall — see blockwall.ts). Detection runs in the page;
// waitForNotCaptcha polls until clear. The "hand off to human" step (focus decky) is done by the
// caller via onChallenge — the challenge is already sitting in the visible web card.

import type { WebContents } from 'electron'

const DETECT_JS = `(() => {
  const sels = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="challenge"]',
    'iframe[title*="captcha" i]',
    'iframe[title*="challenge" i]',
    'div.g-recaptcha',
    'div.h-captcha'
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && el.getBoundingClientRect().width > 0) return 'iframe:' + s;
  }
  const t = (document.title || '').toLowerCase();
  if (t.includes('just a moment') || t.includes('checking your browser')) return 'title:cloudflare';
  if (t.includes('verify you are human')) return 'title:turnstile';
  const u = location.href;
  if (u.includes('/cdn-cgi/challenge') || u.includes('/challenge?')) return 'url:cdn-cgi';
  return null;
})()`

// Detect once. Returns descriptor or null. Swallows eval errors.
export async function detectCaptcha(wc: WebContents): Promise<string | null> {
  try {
    const r = (await wc.executeJavaScript(DETECT_JS)) as string | null
    return r ?? null
  } catch {
    return null
  }
}

export interface CaptchaWaitOpts {
  pollMs?: number
  // Total timeout in ms. Default 120000 (2min) — a CLI/HTTP caller can't wait forever. 0 = forever.
  timeoutMs?: number
  // Consecutive clean polls required before returning. Default 2 (prevents flicker right after nav
  // while iframes are still mounting).
  cleanRequired?: number
  // Fired once when a challenge first appears (the caller focuses decky for the human).
  onChallenge?: (descriptor: string) => void
}

export interface CaptchaWaitResult {
  hit: boolean
  descriptor?: string
}

// Poll until no captcha is detected for `cleanRequired` consecutive checks. Returns whether a
// challenge was hit (and resolved). Throws on timeout. Ref: handoff waitForNotCaptcha.
export async function waitForNotCaptcha(
  wc: WebContents,
  opts: CaptchaWaitOpts = {}
): Promise<CaptchaWaitResult> {
  const pollMs = opts.pollMs ?? 500
  const timeoutMs = opts.timeoutMs ?? 120000
  const cleanRequired = opts.cleanRequired ?? 2
  const start = Date.now()
  let clean = 0
  let announced = false
  let firstDesc: string | undefined

  for (;;) {
    const desc = await detectCaptcha(wc)
    if (desc) {
      clean = 0
      if (!announced) {
        announced = true
        firstDesc = desc
        opts.onChallenge?.(desc)
      }
    } else {
      clean++
      if (clean >= cleanRequired) return { hit: announced, descriptor: firstDesc }
    }
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      throw new Error(`captcha-wait: timed out after ${timeoutMs}ms (last=${desc ?? 'clean'})`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

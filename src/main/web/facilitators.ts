// Navigation facilitators for web cards — the decky port of handoff's SDK primitives, driving an
// Electron WebContents instead of a Playwright Page. Two halves:
//
//   1. Page-injected JS (SNAPSHOT_JS / READ_JS / clickJs / typeJs): stringified, run via
//      wc.executeJavaScript. The snapshot tags each interactive element with a sequential
//      `data-mcp-ref` (back-compat with the browser_* MCP tools) AND a deterministic
//      `data-mcp-sid` (stable across re-renders); click/type resolve by either.
//   2. Main-process drivers (settle / waitUntil / waitRequest / clickLabel): loops that poll the
//      page over executeJavaScript. settle/waitRequest read window.__meTracker (installed by
//      resources/webview-preload.js).
//
// Refs: handoff runtime/playwright/{daemon.ts,snapshot.ts} + sdk/client.ts.

import type { WebContents } from 'electron'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── Page-injected JS ─────────────────────────────────────────────────────────

// Snapshot interactive elements + a stable id. Ported from handoff snapshot.ts (FNV-1a hash of
// role|label|ancestor-signature|sibling-index, with _2/_3 collision suffixing) and adapted to
// decky's attribute names. Sets data-mcp-ref (sequential) + data-mcp-sid (stable).
export const SNAPSHOT_JS = `(() => {
  const SEL = [
    'a[href]','button','input','select','textarea',
    '[role=button]','[role=link]','[role=textbox]','[role=combobox]','[role=checkbox]',
    '[role=menuitem]','[role=tab]','[role=option]','[role=switch]','[role=radio]',
    '[contenteditable=true]','[onclick]','[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
    return true;
  };
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.labels && el.labels.length) return el.labels[0].innerText;
      return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }
    if (el.tagName === 'SELECT' && el.labels && el.labels.length) return el.labels[0].innerText;
    return (el.innerText || el.textContent || '').trim();
  };
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const siblingIndex = (el) => {
    if (!el.parentElement) return 0;
    const peers = Array.from(el.parentElement.children).filter(
      (c) => c.tagName === el.tagName && c.getAttribute('role') === el.getAttribute('role'));
    return peers.indexOf(el);
  };
  const ancestorSig = (el) => {
    const parts = []; let cur = el.parentElement; let d = 0;
    while (cur && d < 4) { parts.push(cur.tagName.toLowerCase() + '[' + siblingIndex(cur) + ']'); cur = cur.parentElement; d++; }
    return parts.join('/');
  };
  for (const el of document.querySelectorAll('[data-mcp-ref]')) el.removeAttribute('data-mcp-ref');
  for (const el of document.querySelectorAll('[data-mcp-sid]')) el.removeAttribute('data-mcp-sid');
  const els = Array.from(document.querySelectorAll(SEL)).filter(isVisible);
  const seen = new Map();
  const out = [];
  let i = 0;
  for (const el of els) {
    const ref = 'e' + (++i);
    el.setAttribute('data-mcp-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = (labelFor(el) || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
    let sid = hash(role + '|' + label.slice(0, 80) + '|' + ancestorSig(el) + '|' + siblingIndex(el));
    const n = (seen.get(sid) || 0) + 1; seen.set(sid, n);
    if (n > 1) sid = sid + '_' + n;
    el.setAttribute('data-mcp-sid', sid);
    const rec = { ref, sid, role, name: label.slice(0, 80), tag: el.tagName.toLowerCase() };
    const type = el.getAttribute('type'); if (type) rec.type = type;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      rec.value = (type === 'password' && (el.value || '').length) ? '***' : (el.value || '').slice(0, 140);
    }
    if (el.tagName === 'SELECT') {
      rec.value = el.value || '';
      rec.options = Array.from(el.options).map((o) => ({ value: o.value, label: o.text }));
    }
    // Interactive STATE — so the agent sees toggle/checkbox/radio/tab/accordion state
    // instead of guessing from the label. Only emit a field when the element actually
    // carries that state, to keep records lean.
    const ariaChecked = el.getAttribute('aria-checked');
    if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) rec.checked = !!el.checked;
    else if (ariaChecked === 'true' || ariaChecked === 'false') rec.checked = ariaChecked === 'true';
    const ariaExpanded = el.getAttribute('aria-expanded');
    if (ariaExpanded === 'true' || ariaExpanded === 'false') rec.expanded = ariaExpanded === 'true';
    const ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected === 'true' || ariaSelected === 'false') rec.selected = ariaSelected === 'true';
    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed === 'true' || ariaPressed === 'false') rec.pressed = ariaPressed === 'true';
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') rec.disabled = true;
    out.push(rec);
  }
  return { url: location.href, title: document.title, elements: out };
})()`

export const READ_JS = `(() => ({
  url: location.href, title: document.title,
  text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000)
}))()`

// Resolve a target by data-mcp-ref OR data-mcp-sid — the agent can address by the volatile
// sequential ref (from the latest snapshot) or by the stable id (survives re-render).
function selectorFor(refLit: string): string {
  return `document.querySelector('[data-mcp-ref=' + ${refLit} + ']') || document.querySelector('[data-mcp-sid=' + ${refLit} + ']')`
}

export function clickJs(ref: string): string {
  const refLit = JSON.stringify(JSON.stringify(ref))
  return `(() => {
    const el = ${selectorFor(refLit)};
    if (!el) return { ok: false, error: 'ref not found: ' + ${JSON.stringify(ref)} };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true };
  })()`
}

export function typeJs(ref: string, text: string): string {
  const refLit = JSON.stringify(JSON.stringify(ref))
  const textLit = JSON.stringify(text)
  return `(() => {
    const el = ${selectorFor(refLit)};
    if (!el) return { ok: false, error: 'ref not found: ' + ${JSON.stringify(ref)} };
    el.focus();
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${textLit}); else el.value = ${textLit};
    } else if (el.isContentEditable) {
      el.textContent = ${textLit};
    } else {
      return { ok: false, error: 'element is not typable' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`
}

// Scroll the page (or a specific ref into view) and dispatch real scroll events. Plain
// `scrollTop = …` via eval often does NOT fire the IntersectionObserver that SPAs (e.g. Google
// Ads) use to lazy-render sections, so the content stays stuck on "Loading". This finds the
// tallest scrollable container, moves it, and dispatches `scroll` so observers/listeners react.
// dir: 'down' (default) | 'up' | 'top' | 'bottom'. `amount` overrides the per-step pixels.
export function scrollJs(opts: { ref?: string; dir?: string; amount?: number }): string {
  const dirLit = JSON.stringify(opts.dir || 'down')
  const amtLit = typeof opts.amount === 'number' ? String(opts.amount) : 'null'
  const refExpr = opts.ref ? JSON.stringify(opts.ref) : 'null'
  return `(() => {
    const ref = ${refExpr};
    const dir = ${dirLit};
    const amount = ${amtLit};
    const pickScroller = () => {
      const se = document.scrollingElement || document.documentElement;
      let best = se, bestScore = se.scrollHeight - se.clientHeight;
      for (const e of document.querySelectorAll('*')) {
        const score = e.scrollHeight - e.clientHeight;
        if (score > bestScore && e.clientHeight > 200) { best = e; bestScore = score; }
      }
      return best;
    };
    if (ref) {
      const el = document.querySelector('[data-mcp-ref=' + JSON.stringify(ref) + ']') || document.querySelector('[data-mcp-sid=' + JSON.stringify(ref) + ']');
      if (!el) return { ok: false, error: 'ref not found: ' + ref };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
      return { ok: true, scrolledTo: ref };
    }
    const sc = pickScroller();
    const step = amount != null ? amount : Math.round(sc.clientHeight * 0.9);
    if (dir === 'top') sc.scrollTop = 0;
    else if (dir === 'bottom') sc.scrollTop = sc.scrollHeight;
    else if (dir === 'up') sc.scrollTop -= step;
    else sc.scrollTop += step;
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    window.dispatchEvent(new Event('scroll'));
    return { ok: true, y: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  })()`
}

// ── Main-process drivers ───────────────────────────────────────────────────────

export interface SettleOpts {
  timeoutMs?: number
  quietMs?: number
}

export interface SettleResult {
  settled: boolean
  timedOut: boolean
  elapsedMs: number
}

// Wait for the page to go quiet: fonts ready, then network in-flight = 0 AND no DOM mutations,
// both sustained for quietMs, then 2 rAFs to flush paint. Caps at timeoutMs (default 5s) — does
// NOT throw on timeout (noisy SPAs never fully settle; the caller can fall back to wait-until /
// wait-request). Mirrors handoff waitForSettled (runtime/playwright/daemon.ts).
export async function settle(wc: WebContents, opts: SettleOpts = {}): Promise<SettleResult> {
  const timeout = opts.timeoutMs ?? 5000
  const quietMs = opts.quietMs ?? 250
  const start = Date.now()
  const done = (settled: boolean, timedOut: boolean): SettleResult => ({
    settled,
    timedOut,
    elapsedMs: Date.now() - start
  })
  // Step 1: fonts (5s internal fallback if fonts.ready never resolves).
  try {
    await wc.executeJavaScript(
      `new Promise((res) => { if (!document.fonts || !document.fonts.ready) return res(); const t = setTimeout(() => res(), 5000); document.fonts.ready.then(() => { clearTimeout(t); res(); }); })`,
      true
    )
  } catch {
    return done(false, false) // page closed / navigated away
  }
  // Step 2: network + DOM quiet sustained for quietMs.
  let networkQuietSince: number | null = null
  let timedOut = true
  while (Date.now() - start < timeout) {
    let inFlight = 0
    let lastMut = Date.now()
    try {
      const stat = (await wc.executeJavaScript(
        `(() => { const t = window.__meTracker; return [t ? t.inFlight : 0, t ? t.lastMutation : Date.now()]; })()`
      )) as [number, number]
      inFlight = stat[0]
      lastMut = stat[1]
    } catch {
      return done(false, false)
    }
    const now = Date.now()
    if (inFlight === 0) {
      if (networkQuietSince === null) networkQuietSince = now
    } else {
      networkQuietSince = null
    }
    const networkQuiet = networkQuietSince !== null && now - networkQuietSince >= quietMs
    const domQuiet = now - lastMut >= quietMs
    if (networkQuiet && domQuiet) {
      timedOut = false
      break
    }
    await sleep(80)
  }
  // Step 3: 2 rAFs to flush pending paint.
  try {
    await wc.executeJavaScript(
      `new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))`,
      true
    )
  } catch {
    // ignore
  }
  return done(!timedOut, timedOut)
}

export interface WaitUntilOpts {
  timeoutMs?: number
  pollMs?: number
}

// Poll a JS expression in the page until it returns truthy. Tolerates "Execution context
// destroyed" (navigation mid-eval) by retrying. Throws on timeout. Ref: handoff waitUntil.
export async function waitUntil(
  wc: WebContents,
  expression: string,
  opts: WaitUntilOpts = {}
): Promise<{ ok: true; elapsedMs: number }> {
  const timeout = opts.timeoutMs ?? 15000
  const poll = opts.pollMs ?? 300
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const ok = await wc.executeJavaScript(
        `(() => { try { return Boolean(${expression}); } catch { return false; } })()`
      )
      if (ok) return { ok: true, elapsedMs: Date.now() - start }
    } catch (e) {
      if (!String((e as Error).message).includes('Execution context')) throw e
    }
    await sleep(poll)
  }
  throw new Error(`wait-until: timed out (${timeout}ms) on: ${expression}`)
}

export interface WaitRequestOpts {
  method?: string
  timeoutMs?: number
  matchRecentMs?: number
}

export interface NetworkHit {
  url: string
  method: string
  status: number
  failed: boolean
  durationMs: number
}

interface TrackedRequest {
  url: string
  method: string
  status: number
  startedAt: number
  finishedAt?: number
  failed: boolean
}

// Convert a glob (with *) OR a /regex/ string into a RegExp. A plain string with no * is treated
// as a substring (anchored loosely) — same ergonomics as handoff's pattern matching.
function patternToRegExp(pattern: string): RegExp {
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last = pattern.lastIndexOf('/')
    return new RegExp(pattern.slice(1, last), pattern.slice(last + 1))
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(escaped)
  }
  return new RegExp(pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
}

// Wait for a network request whose URL matches `pattern` (+ optional method) to FINISH. Reads the
// __meTracker ring buffer (fetch + XHR). Checks requests that started/finished within matchRecentMs
// before the ask (captures in-flight that began just before), then polls for new ones up to
// timeoutMs. Ref: handoff waitForRequest (decky reads the preload ring buffer, not CDP).
export async function waitRequest(
  wc: WebContents,
  pattern: string,
  opts: WaitRequestOpts = {}
): Promise<NetworkHit> {
  const timeout = opts.timeoutMs ?? 30000
  const matchRecent = opts.matchRecentMs ?? 3000
  const method = opts.method ? opts.method.toUpperCase() : null
  const re = patternToRegExp(pattern)
  const askStart = Date.now()
  const matchesPattern = (r: TrackedRequest): boolean =>
    (!method || r.method === method) && re.test(r.url)
  const isEligible = (r: TrackedRequest): boolean => {
    const lowerBound = askStart - matchRecent
    return (r.finishedAt ?? r.startedAt) >= lowerBound
  }
  while (Date.now() - askStart < timeout) {
    let requests: TrackedRequest[] = []
    try {
      requests = (await wc.executeJavaScript(
        `(() => { const t = window.__meTracker; return t && t.requests ? t.requests : []; })()`
      )) as TrackedRequest[]
    } catch {
      return Promise.reject(new Error('wait-request: page closed mid-wait'))
    }
    const hit = requests.find(
      (r) => matchesPattern(r) && isEligible(r) && r.finishedAt !== undefined
    )
    if (hit) {
      return {
        url: hit.url,
        method: hit.method,
        status: hit.status,
        failed: hit.failed,
        durationMs: (hit.finishedAt ?? Date.now()) - hit.startedAt
      }
    }
    await sleep(60)
  }
  throw new Error(`wait-request: timeout (${timeout}ms) for ${pattern}`)
}

export interface ClickLabelOpts {
  strict?: boolean
  index?: number
}

interface SnapElement {
  ref: string
  sid: string
  role: string
  name: string
  tag: string
  value?: string
}

// Click the first interactive element whose name/value matches the regex. Among ties, prefers the
// SHORTEST label (JSF/React wrappers concatenate child labels; real targets have tight labels), then
// interactive tags over wrappers. Ref: handoff clickLabel (sdk/client.ts). Returns the matched label.
export async function clickLabel(
  wc: WebContents,
  pattern: string,
  opts: ClickLabelOpts = {}
): Promise<{ label: string; ref: string }> {
  const re = patternToRegExp(pattern)
  const snap = (await wc.executeJavaScript(SNAPSHOT_JS)) as { elements: SnapElement[] }
  const matches = snap.elements.filter((e) => re.test(e.name || '') || re.test(e.value || ''))
  if (!matches.length) throw new Error(`click-label: no match for ${pattern}`)
  const isInteractive = (e: SnapElement): boolean =>
    e.tag === 'a' || e.tag === 'button' || e.tag === 'input'
  matches.sort((a, b) => {
    const da = (a.name || a.value || '').length
    const db = (b.name || b.value || '').length
    if (da !== db) return da - db
    return (isInteractive(a) ? 0 : 1) - (isInteractive(b) ? 0 : 1)
  })
  if (
    opts.strict &&
    matches.length > 1 &&
    (matches[0].name || '').length === (matches[1].name || '').length
  ) {
    throw new Error(
      `click-label: ambiguous, ${matches.length} matches for ${pattern}: ` +
        matches
          .slice(0, 5)
          .map((m) => JSON.stringify(m.name))
          .join(', ')
    )
  }
  const target = matches[opts.index ?? 0]
  if (!target) throw new Error(`click-label: index ${opts.index} out of bounds (${matches.length})`)
  try {
    await wc.executeJavaScript(clickJs(target.ref), true)
  } catch (e) {
    const msg = String((e as Error).message)
    if (!msg.includes('Execution context') && !msg.includes('Timeout')) throw e
  }
  return { label: target.name, ref: target.ref }
}

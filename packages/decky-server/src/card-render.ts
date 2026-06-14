import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Conteúdo estático de renderização de cards (CSS default, marked bundlado, widgets vanilla,
// MIME table, wrap markdown→HTML). Compartilhado entre o protocol card:// e o http-server
// que serve mesmos bytes pra URLs http://127.0.0.1 dos cards HTML opensados via preview_show.
// Puro — sem Electron API.

// Bundle marked locally as a virtual route. The old wrapper imported it from
// https://esm.sh/marked@12 at every card open; on the first render of a fresh card://
// page the import sometimes never resolved (race between the persist:deckweb session
// warm-up and a cross-origin ESM fetch), leaving the page stuck on "carregando…". A
// local copy removes the network round-trip and any session-warm-up race.
const requireForResolve = createRequire(import.meta.url)
function loadMarkedSource(): string {
  try {
    return readFileSync(requireForResolve.resolve('marked'), 'utf-8')
  } catch (e) {
    console.error('[card-render] failed to load marked.esm.js — markdown cards may not render', e)
    return ''
  }
}
const MARKED_JS = loadMarkedSource()
export const MARKED_URL = '/__decky/lib/marked.js'

// Existing .html cards on disk still reference https://esm.sh/marked@12 (and the older /v13/
// path it sometimes redirected through). Rewrite to the local virtual route when serving so
// legacy cards switch over without needing to be regenerated.
// Bound `marked` with a non-word lookahead so `marked-utils` etc don't match.
const ESM_MARKED_RE = /https:\/\/esm\.sh\/marked(?=[@/'"\s)])(?:@\d+(?:\.\d+(?:\.\d+)?)?)?(?:\/[^"'\s)]*)?/g
export function rewriteMarkedImports(html: string): string {
  return MARKED_JS ? html.replace(ESM_MARKED_RE, MARKED_URL) : html
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf'
}

// Workspace-default stylesheet servido em /__decky/default.css e auto-injetado em HTML cards
// que não trazem <style>/<link>. Espelha a paleta/tipografia .md-body do renderer.
const DEFAULT_CARD_CSS = `
:root {
  --bg-0: #1e2330;
  --bg-1: #262c3b;
  --bg-2: #353c4f;
  --border: #2e3447;
  --text-1: #d7dee9;
  --text-2: #95a0b3;
  --text-3: #6a7385;
  --accent: #8a5cf6;
  --link: #4ec9ff;
  --wikilink: #c4a8ff;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--bg-2);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background: var(--text-3); background-clip: padding-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg-0);
  color: var(--text-1);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  padding: 20px 28px 60px;
  -webkit-font-smoothing: antialiased;
  user-select: text;
}
h1, h2, h3, h4 {
  margin: 1.4em 0 0.6em;
  font-weight: 600;
  line-height: 1.25;
  color: var(--text-1);
}
h1 { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
h3 { font-size: 1.15em; }
h4 { font-size: 1em; }
p { margin: 0.6em 0; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.6em; margin: 0.4em 0; }
li { margin: 0.2em 0; }
strong { font-weight: 600; }
em { font-style: italic; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }
blockquote {
  border-left: 3px solid var(--border);
  padding: 0 12px;
  margin: 0.8em 0;
  color: var(--text-2);
}
code {
  font-family: var(--mono);
  background: var(--bg-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.88em;
  color: var(--text-1);
}
pre {
  background: #0d1117;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
  overflow: auto;
  margin: 0.8em 0;
}
pre code { background: transparent; padding: 0; font-size: 12.5px; line-height: 1.5; }
table {
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 13px;
}
th, td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
th { background: var(--bg-1); font-weight: 600; }
input[type=text], input[type=search], input[type=number], input[type=email], textarea, select {
  background: var(--bg-1);
  border: 1px solid var(--border);
  color: var(--text-1);
  padding: 6px 10px;
  border-radius: 4px;
  font: inherit;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
}
input[type=checkbox] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin: 0 0.5em 0 0;
  vertical-align: -2px;
  border: 1.5px solid var(--text-3);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}
input[type=checkbox]:checked { background: var(--accent); border-color: var(--accent); }
input[type=checkbox]:checked::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  width: 4px;
  height: 8px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
button {
  background: var(--bg-2);
  border: 1px solid var(--border);
  color: var(--text-1);
  padding: 6px 12px;
  border-radius: 4px;
  font: 600 13px/1 var(--sans);
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
button:hover:not(:disabled) { background: #404863; border-color: var(--text-3); }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: 0.5; cursor: default; }
`

export const DEFAULT_CSS_PATH = '/__decky/default.css'

export function getDefaultCardCss(): string {
  return DEFAULT_CARD_CSS
}

// Heurística: HTML que já traz <style> ou um <link rel="stylesheet"> próprio tem tema
// — não injetamos. Caso contrário (markup nu), recebe o WS-default. Ignora a tag fechada
// (`<style/>`) que é rara em HTML real.
const HAS_THEME_RE = /<style\b|<link\b[^>]*rel\s*=\s*["']?stylesheet/i
const HEAD_CLOSE_RE = /<\/head\s*>/i
const HEAD_OPEN_RE = /<head\b[^>]*>/i
const HTML_OPEN_RE = /<html\b[^>]*>/i

export function injectDefaultCss(html: string): string {
  if (HAS_THEME_RE.test(html)) return html
  const linkTag = `<link rel="stylesheet" href="${DEFAULT_CSS_PATH}">`
  // Caso normal: tem </head> — injeta antes.
  if (HEAD_CLOSE_RE.test(html)) {
    return html.replace(HEAD_CLOSE_RE, `${linkTag}$&`)
  }
  // Caso degradado: tem <head ...> sem fechar — injeta logo depois.
  if (HEAD_OPEN_RE.test(html)) {
    return html.replace(HEAD_OPEN_RE, `$&${linkTag}`)
  }
  // Caso ainda mais degradado: tem <html ...> mas sem <head> — cria um.
  if (HTML_OPEN_RE.test(html)) {
    return html.replace(HTML_OPEN_RE, `$&<head>${linkTag}</head>`)
  }
  // Fragmento solto: prepend.
  return `<head>${linkTag}</head>` + html
}

// Wrap raw markdown content as an HTML mini-app — serves the same scaffold as the
// renderer's wrapMarkdownAsHtml, so `.md` files requested directly from card:// (ou http://)
// render formatted (instead of "octet-stream" raw text) when the user navigates the URL
// bar of an html card to a .md sibling.
export function wrapMarkdownAsHtml(content: string): string {
  const safeContent = content.replace(/<\/script/gi, '<\\/script')
  // Extract first heading as page title so tab strip / window title shows something
  // meaningful instead of "Card". Falls back to "Card" only when content has no headings.
  const headingMatch = content.match(/^#{1,6}\s+(.+?)\s*$/m)
  const rawTitle = headingMatch ? headingMatch[1].trim() : 'Card'
  const title = rawTitle.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch] ?? ch)
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<link rel="stylesheet" href="/__decky/default.css">
<style>
  body { padding: 24px; margin: 0; }
</style>
</head>
<body>
<article class="md-body" id="content">carregando…</article>
<script type="text/markdown" id="md-src">${safeContent}</script>
<script type="module">
  import { marked } from '${MARKED_URL}'
  const src = document.getElementById('md-src').textContent
  document.getElementById('content').innerHTML = marked.parse(src, { gfm: true, breaks: false })
</script>
</body>
</html>
`
}

// === Widget runtime servido sob /__decky/widgets/* — vanilla JS, auto-init no DOMContentLoaded.
// Cada widget procura seu seletor data-decky-* no DOM, lê o JSON spec do textContent,
// renderiza in-place. Sem framework, sem dependências (mermaid via CDN).

// Compartilhado: helpers de CSS injection idempotente. Cada widget chama injectOnce com seu
// próprio id pra garantir que estilos só vão pra <head> uma vez por página, mesmo com N
// widgets do mesmo tipo.
const WIDGET_HELPERS_JS = `
window.__deckyHelpers = window.__deckyHelpers || (() => {
  const injected = new Set();
  return {
    injectOnce(id, css) {
      if (injected.has(id)) return;
      injected.add(id);
      const s = document.createElement('style');
      s.setAttribute('data-decky-widget', id);
      s.textContent = css;
      document.head.appendChild(s);
    },
    parseSpec(el) {
      const raw = (el.textContent || '').trim();
      if (!raw) return {};
      try { return JSON.parse(raw); } catch (e) {
        console.error('[decky] invalid widget JSON', e, raw.slice(0, 200));
        return {};
      }
    },
  };
})();
`

const FLOW_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-flow { position: relative; width: 100%; height: 460px; margin: 1em 0;
      background: var(--bg-0); border: 1px solid var(--border); border-radius: 6px;
      overflow: hidden; user-select: none; }
    .dk-flow svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .dk-flow .dk-node { position: absolute; min-width: 160px; max-width: 220px;
      background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; cursor: grab; font: 13px/1.4 var(--sans);
      box-shadow: 0 1px 3px rgba(0,0,0,0.2); transition: box-shadow 120ms, border-color 120ms; }
    .dk-flow .dk-node.dragging { cursor: grabbing; box-shadow: 0 6px 16px rgba(0,0,0,0.4); }
    .dk-flow .dk-node.active { border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(138,92,246,0.22), 0 0 18px rgba(138,92,246,0.5);
      animation: dk-pulse 1.6s ease-in-out infinite; }
    @keyframes dk-pulse {
      0%, 100% { box-shadow: 0 0 0 2px rgba(138,92,246,0.22), 0 0 14px rgba(138,92,246,0.40); }
      50%      { box-shadow: 0 0 0 2px rgba(138,92,246,0.42), 0 0 24px rgba(138,92,246,0.85); }
    }
    .dk-flow .dk-node.tone-info { border-left: 3px solid #4ec9ff; }
    .dk-flow .dk-node.tone-ok   { border-left: 3px solid #4ade80; }
    .dk-flow .dk-node.tone-warn { border-left: 3px solid #fbbf24; }
    .dk-flow .dk-node.tone-bad  { border-left: 3px solid #f87171; }
    .dk-flow .dk-node .dk-node-title { font-weight: 600; color: var(--text-1); margin-bottom: 2px; }
    .dk-flow .dk-node .dk-node-body { color: var(--text-2); font-size: 12px; white-space: pre-line; }
    .dk-flow .dk-edge { stroke: var(--text-3); stroke-width: 1.5; fill: none; }
    .dk-flow .dk-edge.animated { stroke-dasharray: 5 5; animation: dk-dash 1.2s linear infinite; }
    @keyframes dk-dash { to { stroke-dashoffset: -10; } }
    .dk-flow .dk-edge-label { fill: var(--text-2); font: 11px var(--sans);
      paint-order: stroke; stroke: var(--bg-0); stroke-width: 4; }
    .dk-flow .dk-edge-arrow { fill: var(--text-3); }
  \`;
  h.injectOnce('flow', CSS);

  function bezierPath(x1, y1, x2, y2) {
    // Horizontal bezier: control points expanded along x.
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.4);
    return \`M\${x1},\${y1} C\${x1 + dx},\${y1} \${x2 - dx},\${y2} \${x2},\${y2}\`;
  }

  function render(container, spec) {
    const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
    const edges = Array.isArray(spec.edges) ? spec.edges : [];
    container.innerHTML = '';
    // SVG layer (edges + arrowhead defs).
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', 'dk-arrow-' + Math.random().toString(36).slice(2, 8));
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrowPath = document.createElementNS(svgNS, 'path');
    arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrowPath.setAttribute('class', 'dk-edge-arrow');
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);
    container.appendChild(svg);

    // Node DOM map.
    const nodeEls = new Map();
    const nodeState = new Map();
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = 'dk-node' + (n.data?.tone ? ' tone-' + n.data.tone : '') + (n.data?.active ? ' active' : '');
      el.style.left = (n.position?.x ?? 0) + 'px';
      el.style.top = (n.position?.y ?? 0) + 'px';
      el.dataset.id = n.id;
      const title = document.createElement('div');
      title.className = 'dk-node-title';
      title.textContent = n.data?.title ?? n.id;
      el.appendChild(title);
      if (n.data?.body) {
        const body = document.createElement('div');
        body.className = 'dk-node-body';
        body.textContent = n.data.body;
        el.appendChild(body);
      }
      container.appendChild(el);
      nodeEls.set(n.id, el);
      nodeState.set(n.id, { x: n.position?.x ?? 0, y: n.position?.y ?? 0 });
    }

    // Edges (drawn after nodes know their sizes).
    const edgeEls = new Map();
    for (const e of edges) {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'dk-edge' + (e.animated ? ' animated' : ''));
      path.setAttribute('marker-end', 'url(#' + marker.id + ')');
      svg.appendChild(path);
      let labelEl = null;
      if (e.label) {
        labelEl = document.createElementNS(svgNS, 'text');
        labelEl.setAttribute('class', 'dk-edge-label');
        labelEl.setAttribute('text-anchor', 'middle');
        labelEl.textContent = e.label;
        svg.appendChild(labelEl);
      }
      edgeEls.set(e.id || (e.source + '->' + e.target), { path, labelEl, source: e.source, target: e.target });
    }

    function updateEdges() {
      for (const ed of edgeEls.values()) {
        const src = nodeEls.get(ed.source);
        const tgt = nodeEls.get(ed.target);
        if (!src || !tgt) continue;
        const sr = src.getBoundingClientRect();
        const tr = tgt.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        const x1 = sr.right - cr.left;
        const y1 = sr.top + sr.height / 2 - cr.top;
        const x2 = tr.left - cr.left;
        const y2 = tr.top + tr.height / 2 - cr.top;
        ed.path.setAttribute('d', bezierPath(x1, y1, x2, y2));
        if (ed.labelEl) {
          ed.labelEl.setAttribute('x', String((x1 + x2) / 2));
          ed.labelEl.setAttribute('y', String((y1 + y2) / 2 - 4));
        }
      }
    }
    // After nodes measure (next frame).
    requestAnimationFrame(updateEdges);

    // Drag.
    let drag = null;
    container.addEventListener('mousedown', (ev) => {
      const target = ev.target.closest('.dk-node');
      if (!target) return;
      ev.preventDefault();
      const id = target.dataset.id;
      const st = nodeState.get(id);
      drag = { id, el: target, startX: ev.clientX, startY: ev.clientY, baseX: st.x, baseY: st.y };
      target.classList.add('dragging');
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      const nx = drag.baseX + (ev.clientX - drag.startX);
      const ny = drag.baseY + (ev.clientY - drag.startY);
      drag.el.style.left = nx + 'px';
      drag.el.style.top = ny + 'px';
      nodeState.set(drag.id, { x: nx, y: ny });
      updateEdges();
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag.el.classList.remove('dragging');
      drag = null;
    });
    // Also: any resize/scroll of the page repositions edges relative to container.
    const ro = new ResizeObserver(updateEdges);
    ro.observe(container);
  }

  function initAll() {
    document.querySelectorAll('[data-decky-flow]').forEach((el) => {
      if (el.dataset.deckyInit) return;
      el.dataset.deckyInit = '1';
      const spec = h.parseSpec(el);
      render(el, spec);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
`

const CHECKLIST_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-checklist { margin: 1em 0; padding: 0; list-style: none; }
    .dk-checklist li { display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 8px; border-radius: 4px; cursor: pointer;
      transition: background 80ms; }
    .dk-checklist li:hover { background: var(--bg-1); }
    .dk-checklist li.done .dk-cl-label { text-decoration: line-through; color: var(--text-3); }
    .dk-checklist input[type=checkbox] { margin-top: 3px; flex-shrink: 0; }
    .dk-checklist .dk-cl-label { color: var(--text-1); user-select: text; }
    .dk-checklist .dk-cl-label code { font-size: 12px; }
  \`;
  h.injectOnce('checklist', CSS);

  function render(container, spec) {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const key = spec.id ? 'dk-checklist:' + spec.id : null;
    // Load persisted overrides (id -> bool). If no widget id, no persistence.
    let saved = {};
    if (key) {
      try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
    }
    const ul = document.createElement('ul');
    ul.className = 'dk-checklist';
    container.innerHTML = '';
    container.appendChild(ul);
    function persist() {
      if (!key) return;
      localStorage.setItem(key, JSON.stringify(saved));
    }
    for (const it of items) {
      const li = document.createElement('li');
      const id = it.id;
      const checked = id && id in saved ? !!saved[id] : !!it.checked;
      if (checked) li.classList.add('done');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      const lbl = document.createElement('span');
      lbl.className = 'dk-cl-label';
      // Permite markdown leve (backticks → <code>). Bem básico, suficiente pros itens reais.
      const html = (it.label || '').replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      lbl.innerHTML = html;
      li.appendChild(cb);
      li.appendChild(lbl);
      ul.appendChild(li);
      const toggle = (next) => {
        cb.checked = next;
        if (next) li.classList.add('done'); else li.classList.remove('done');
        if (id) { saved[id] = next; persist(); }
      };
      li.addEventListener('click', (e) => {
        if (e.target === cb) return;
        toggle(!cb.checked);
      });
      cb.addEventListener('change', () => toggle(cb.checked));
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-checklist]').forEach((el) => {
      if (el.dataset.deckyInit) return;
      el.dataset.deckyInit = '1';
      const spec = h.parseSpec(el);
      render(el, spec);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
`

const MERMAID_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-mermaid { display: flex; justify-content: center; padding: 12px;
      margin: 1em 0; background: var(--bg-0); border: 1px solid var(--border);
      border-radius: 6px; overflow: auto; }
    .dk-mermaid svg { max-width: 100%; height: auto; }
    .dk-mermaid-err { color: #f87171; font: 11.5px var(--mono); padding: 8px;
      background: var(--bg-1); border: 1px solid #f87171; border-radius: 4px; }
  \`;
  h.injectOnce('mermaid', CSS);

  let mermaidPromise = null;
  function loadMermaid() {
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = import('https://esm.sh/mermaid@10').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark',
        themeVariables: { background: '#1e2330', primaryColor: '#262c3b',
          primaryTextColor: '#d7dee9', lineColor: '#6a7385',
          mainBkg: '#262c3b', nodeBorder: '#2e3447' } });
      return mermaid;
    });
    return mermaidPromise;
  }

  async function render(el, src) {
    try {
      const mermaid = await loadMermaid();
      const id = 'dkm-' + Math.random().toString(36).slice(2, 9);
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement('div');
      wrap.className = 'dk-mermaid';
      wrap.innerHTML = svg;
      el.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'dk-mermaid-err';
      err.textContent = 'mermaid: ' + (e?.message ?? String(e));
      el.replaceWith(err);
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-mermaid]').forEach((el) => {
      if (el.dataset.deckyInit) return;
      el.dataset.deckyInit = '1';
      const src = (el.textContent || '').trim();
      render(el, src);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
`

// Virtual routes — paths served from inline strings, not from disk.
const VIRTUAL_ROUTES: Record<string, { body: string; mime: string }> = {
  '/__decky/widgets/flow.js': { body: FLOW_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/checklist.js': {
    body: CHECKLIST_JS,
    mime: 'text/javascript; charset=utf-8'
  },
  '/__decky/widgets/mermaid.js': { body: MERMAID_JS, mime: 'text/javascript; charset=utf-8' },
  // Local marked bundle — replaces the old https://esm.sh/marked@12 import. The empty body
  // case (MARKED_JS load failed) is intentional: serves an empty module that throws on use,
  // surfacing the failure in devtools instead of leaving the page silently stuck.
  [MARKED_URL]: { body: MARKED_JS, mime: 'text/javascript; charset=utf-8' }
}

export function getVirtualRoutes(): Record<string, { body: string; mime: string }> {
  return VIRTUAL_ROUTES
}

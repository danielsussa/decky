import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { KNOWN_WIDGET_TYPES, type CardManifest } from '@decky/shared'

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
  /* Transparente de propósito: o card (WebContentsView) deixa o fundo da app aparecer atrás —
     o overlay de paisagem do tema (body::after) + o bg-0 do shell. Pra "apreciar o fundo". */
  background: transparent;
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

// WS server URL (set by decky-server startup) so card-protocol can inject `window.__deckyWsUrl`
// into served HTML — lets the bridge connect even on `card://` origins where deriving from
// window.location is impossible.
let _wsUrl: string | null = null
export function setCardBridgeWsUrl(url: string | null): void {
  _wsUrl = url
}

// Inject bootstrap globals (cardId from the request pathname, wsUrl if known) into <head> so
// the bridge connects to the right server and identifies its card. Idempotent — checks for the
// marker comment before re-injecting.
const BOOTSTRAP_MARKER = '<!-- decky-bridge-bootstrap -->'
export function injectBridgeBootstrap(html: string, cardId: string): string {
  if (html.includes(BOOTSTRAP_MARKER)) return html
  const safeId = cardId.replace(/[<>&"'\\]/g, '')
  const wsLine = _wsUrl ? `window.__deckyWsUrl=${JSON.stringify(_wsUrl)};` : ''
  const bootstrap = `${BOOTSTRAP_MARKER}\n<script>window.__deckyCardId=${JSON.stringify(safeId)};${wsLine}</script>\n`
  if (HEAD_CLOSE_RE.test(html)) {
    return html.replace(HEAD_CLOSE_RE, `${bootstrap}$&`)
  }
  if (HEAD_OPEN_RE.test(html)) {
    return html.replace(HEAD_OPEN_RE, `$&${bootstrap}`)
  }
  if (HTML_OPEN_RE.test(html)) {
    return html.replace(HTML_OPEN_RE, `$&<head>${bootstrap}</head>`)
  }
  return `<head>${bootstrap}</head>` + html
}

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

const WIDGET_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_WIDGET_TYPES)

function escHtmlText(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))
}
function escAttr(s: string): string {
  return s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c
  )
}

// Renderiza um card-manifesto ({ widgets: [...] }) num mini-app HTML standalone. Cada widget vira
// o mesmo bloco `<div data-decky-<type>>{spec}</div>` que o runtime vanilla já lê hoje — então os
// módulos de widget montam sem alteração; só a fonte (o manifesto JSON) é nova. As tags
// `<script src="/__decky/widgets/<type>.js">` (+ bridge) são emitidas AQUI porque o caminho do
// protocol card:// não roda o injectWidgetScripts (que vive no renderer, só pro preview_html).
// O id do widget é mesclado no spec → o widget vanilla se registra sob o id do manifesto (ops).
// mermaid é o caso especial: lê o textContent como código cru, não como JSON spec.
export function renderManifest(manifest: CardManifest): string {
  const widgets = Array.isArray(manifest.widgets) ? manifest.widgets : []
  const title = escAttr((manifest.title || 'Card').trim() || 'Card')
  const used = new Set<string>()
  const blocks: string[] = []
  for (const w of widgets) {
    const type = String(w?.type || '')
    if (WIDGET_TYPE_SET.has(type)) used.add(type)
    const spec = (w?.spec ?? {}) as Record<string, unknown>
    const inner =
      type === 'mermaid'
        ? escHtmlText(String(spec.src ?? spec.code ?? ''))
        : escHtmlText(JSON.stringify({ id: w?.id, ...spec }))
    blocks.push(
      `<div data-decky-${escAttr(type)} data-decky-wid="${escAttr(String(w?.id ?? ''))}">${inner}</div>`
    )
  }
  const scripts = ['<script src="/__decky/widgets/bridge.js"></script>']
  for (const name of used) scripts.push(`<script src="/__decky/widgets/${name}.js"></script>`)
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<link rel="stylesheet" href="${DEFAULT_CSS_PATH}">
<style>
  body { padding: 28px 32px 56px; margin: 0; font-size: 14.5px; line-height: 1.65; }
  .dk-card-widgets { display: flex; flex-direction: column; gap: 16px; }
</style>
</head>
<body>
<div class="dk-card-widgets">
${blocks.join('\n')}
</div>
${scripts.join('\n')}
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

// title — heading simples, editável inline. spec: { id, text, level?: 1|2|3, readonly? }.
// Edita-se clicando (contenteditable); persiste em localStorage por id. Expõe op setText e getter
// text pro bridge (AI driving). Primeiro widget desenhado já no modelo de card-manifesto.
const TITLE_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-title { margin: 0.1em 0 0.5em; color: var(--text-0, var(--text-1));
      font-weight: 650; line-height: 1.2; letter-spacing: -0.01em; outline: none; }
    .dk-title.dk-lvl1 { font-size: 28px; }
    .dk-title.dk-lvl2 { font-size: 22px; }
    .dk-title.dk-lvl3 { font-size: 18px; }
    .dk-title[contenteditable="true"] { cursor: text; padding: 2px 6px; margin-left: -6px;
      border-radius: 5px; transition: background 80ms, box-shadow 80ms; }
    .dk-title[contenteditable="true"]:hover { background: var(--bg-1); }
    .dk-title[contenteditable="true"]:focus { background: var(--bg-1);
      box-shadow: 0 0 0 1px var(--border); }
    .dk-title:empty::before { content: attr(data-placeholder); color: var(--text-3);
      font-weight: 500; }
  \`;
  h.injectOnce('title', CSS);

  function clampLevel(n) {
    n = Number(n);
    return n === 2 ? 2 : n === 3 ? 3 : 1;
  }

  function render(el, spec) {
    const level = clampLevel(spec.level);
    const key = spec.id ? 'dk-title:' + spec.id : null;
    const readonly = spec.readonly === true;
    let text = typeof spec.text === 'string' ? spec.text : '';
    if (key) {
      try {
        const saved = localStorage.getItem(key);
        if (saved !== null) text = saved;
      } catch (e) { /* ignore */ }
    }

    const node = document.createElement('div');
    node.className = 'dk-title dk-lvl' + level;
    node.setAttribute('role', 'heading');
    node.setAttribute('aria-level', String(level));
    node.setAttribute('data-placeholder', 'Sem título…');
    node.textContent = text;
    if (!readonly) node.setAttribute('contenteditable', 'true');
    el.replaceWith(node);

    function persist() {
      if (!key) return;
      try { localStorage.setItem(key, node.textContent || ''); } catch (e) { /* ignore */ }
    }
    if (!readonly) {
      node.addEventListener('input', persist);
      // Enter confirma (blur) em vez de inserir quebra de linha — é um título, uma linha só.
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); node.blur(); }
      });
    }

    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'title',
        ops: {
          setText: (args) => {
            const a = args || {};
            if (typeof a.text !== 'string') throw new Error('setText: text required');
            node.textContent = a.text;
            persist();
            return { ok: true, text: a.text };
          }
        },
        getters: {
          text: () => node.textContent || ''
        }
      });
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-title]').forEach((el) => {
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

// text — bloco de prosa em markdown. spec: { id, md }. Renderiza via o marked bundlado. Regra de
// composição (validada no `decky`): cada bloco começa com UM h1 (título da seção) e não tem outro
// h1 — força o agente a abrir um novo widget pra cada seção. Op setMd / getter md pro bridge.
const TEXT_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('text', \`
    /* Escala em-based espelhando .md-body (render legado). Cada widget de texto = uma seção
       que era um h2 (##) no markdown, então seu h1 casa com o h2 do md-body (1.4em), o h2
       com o h3 (1.15em), etc. Em vez de px fixo, escala junto com o corpo (14.5px). */
    .dk-text { margin: 0.5em 0; color: var(--text-1); line-height: 1.65; }
    .dk-text > :first-child { margin-top: 0; }
    .dk-text > :last-child { margin-bottom: 0; }
    .dk-text h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 0.5em; line-height: 1.3;
      color: var(--text-0, var(--text-1)); letter-spacing: -0.01em; }
    .dk-text h2 { font-size: 1.15em; font-weight: 600; margin: 1.2em 0 0.4em; }
    .dk-text h3 { font-size: 1em; font-weight: 600; margin: 1em 0 0.3em; }
    .dk-text p { margin: 0.6em 0; }
    .dk-text ul, .dk-text ol { margin: 0.5em 0; padding-left: 1.5em; }
    .dk-text li { margin: 0.2em 0; }
    .dk-text code { font-family: var(--mono); font-size: 0.88em; background: var(--bg-1);
      padding: 1px 4px; border-radius: 3px; }
    .dk-text pre { background: var(--bg-1); padding: 10px 12px; border-radius: 6px; overflow: auto; }
    .dk-text pre code { background: none; padding: 0; }
    .dk-text blockquote { margin: 0.6em 0; padding: 2px 14px; border-radius: 0 4px 4px 0;
      border-left: 3px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 7%, transparent); color: var(--text-2); }
    .dk-text table { border-collapse: collapse; margin: 0.6em 0; }
    .dk-text th, .dk-text td { border: 1px solid var(--border); padding: 4px 8px; }
    .dk-text a { color: var(--accent); }
  \`);

  let markedP = null;
  function loadMarked() {
    if (!markedP) markedP = import('${MARKED_URL}').then((m) => m.marked);
    return markedP;
  }

  function render(el, spec) {
    const wrap = document.createElement('div');
    wrap.className = 'dk-text';
    let md = typeof spec.md === 'string' ? spec.md : (typeof spec.text === 'string' ? spec.text : '');
    async function paint(src) {
      try {
        const marked = await loadMarked();
        wrap.innerHTML = marked.parse(src || '', { gfm: true, breaks: false });
      } catch (e) {
        wrap.textContent = src || '';
      }
    }
    void paint(md);
    el.replaceWith(wrap);
    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'text',
        ops: {
          setMd: async (args) => {
            const a = args || {};
            if (typeof a.md !== 'string') throw new Error('setMd: md required');
            md = a.md;
            await paint(md);
            return { ok: true };
          }
        },
        getters: { md: () => md }
      });
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-text]').forEach((el) => {
      if (el.dataset.deckyInit) return;
      el.dataset.deckyInit = '1';
      render(el, h.parseSpec(el));
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
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

    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      function setNodeActive(id, active) {
        const el = nodeEls.get(id);
        if (!el) return false;
        if (active) el.classList.add('active');
        else el.classList.remove('active');
        return true;
      }
      window.__deckyRegisterWidget(spec.id, {
        type: 'flow',
        ops: {
          setActive: (args) => {
            const a = args || {};
            if (!a.id) throw new Error('setActive: id required');
            const active = a.active !== false;
            if (!setNodeActive(a.id, active)) throw new Error('setActive: node not found: ' + a.id);
            return { ok: true };
          },
          pulseFor: (args) => {
            const a = args || {};
            if (!a.id) throw new Error('pulseFor: id required');
            const ms = typeof a.ms === 'number' && a.ms > 0 ? a.ms : 2000;
            if (!setNodeActive(a.id, true)) throw new Error('pulseFor: node not found: ' + a.id);
            return new Promise((resolve) => {
              setTimeout(() => { setNodeActive(a.id, false); resolve({ ok: true, ms }); }, ms);
            });
          }
        },
        getters: {
          nodes: () => nodes.map((n) => {
            const pos = nodeState.get(n.id);
            return { ...n, position: pos ? { x: pos.x, y: pos.y } : n.position };
          }),
          edges: () => edges.slice(),
          positions: () => {
            const out = {};
            for (const [id, p] of nodeState.entries()) out[id] = { x: p.x, y: p.y };
            return out;
          }
        }
      });
    }
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
    .dk-checklist { margin: 0.4em 0; padding: 0; list-style: none; }
    .dk-checklist li { display: flex; align-items: flex-start; gap: 8px;
      padding: 2px 8px; border-radius: 4px; cursor: pointer;
      transition: background 80ms; }
    .dk-checklist li:hover { background: var(--bg-1); }
    .dk-checklist li.done .dk-cl-label { text-decoration: line-through; color: var(--text-3); }
    .dk-checklist input[type=checkbox] { margin-top: 3px; flex-shrink: 0; }
    .dk-checklist .dk-cl-label { color: var(--text-1); user-select: text; }
    .dk-checklist .dk-cl-label code { font-size: 12px; }
  \`;
  h.injectOnce('checklist', CSS);

  function render(container, spec) {
    const items = Array.isArray(spec.items) ? spec.items.slice() : [];
    const key = spec.id ? 'dk-checklist:' + spec.id : null;
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

    // Per-item handles so external ops (AI driving) can mutate items by id.
    const handles = new Map();

    function buildItem(it) {
      const li = document.createElement('li');
      const id = it.id;
      const startChecked = id && id in saved ? !!saved[id] : !!it.checked;
      if (startChecked) li.classList.add('done');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = startChecked;
      const lbl = document.createElement('span');
      lbl.className = 'dk-cl-label';
      const html = (it.label || '').replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      lbl.innerHTML = html;
      li.appendChild(cb);
      li.appendChild(lbl);
      ul.appendChild(li);
      const setChecked = (next) => {
        cb.checked = next;
        if (next) li.classList.add('done'); else li.classList.remove('done');
        if (id) { saved[id] = next; persist(); }
      };
      li.addEventListener('click', (e) => {
        if (e.target === cb) return;
        setChecked(!cb.checked);
      });
      cb.addEventListener('change', () => setChecked(cb.checked));
      if (id) handles.set(id, { setChecked, getChecked: () => cb.checked });
    }

    for (const it of items) buildItem(it);

    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'checklist',
        ops: {
          toggle: (args) => {
            const a = args || {};
            if (!a.id) throw new Error('toggle: id required');
            const h = handles.get(a.id);
            if (!h) throw new Error('toggle: item not found: ' + a.id);
            const next = !h.getChecked();
            h.setChecked(next);
            return { ok: true, checked: next };
          },
          check: (args) => {
            const a = args || {};
            if (!a.id) throw new Error('check: id required');
            const h = handles.get(a.id);
            if (!h) throw new Error('check: item not found: ' + a.id);
            const next = a.checked !== false;
            h.setChecked(next);
            return { ok: true, checked: next };
          },
          setItems: (args) => {
            const a = args || {};
            if (!Array.isArray(a.items)) throw new Error('setItems: items[] required');
            // Wipe + rebuild — preserves persistence per id since saved[] is keyed by id.
            ul.innerHTML = '';
            handles.clear();
            for (const it of a.items) buildItem(it);
            return { ok: true, count: a.items.length };
          }
        },
        getters: {
          items: () => Array.from(handles.entries()).map(([id, h]) => ({ id, checked: h.getChecked() })),
          checked: () => Array.from(handles.entries()).filter(([, h]) => h.getChecked()).map(([id]) => id)
        }
      });
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

const MATRIX_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-matrix { position: relative; margin: 1em 0; overflow-x: auto; }
    .dk-matrix .dk-matrix-empty { padding: 12px; border: 1px dashed var(--border);
      border-radius: 6px; color: var(--text-3); font: 12px var(--mono); text-align: center; }
    .dk-matrix table { border-collapse: separate; border-spacing: 0; width: 100%;
      font-size: 13px; background: var(--bg-1); border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden; }
    .dk-matrix th, .dk-matrix td { padding: 8px 10px; text-align: center;
      border-bottom: 1px solid var(--border); }
    .dk-matrix tr:last-child th, .dk-matrix tr:last-child td { border-bottom: none; }
    .dk-matrix .dk-corner { background: var(--bg-0); text-align: left !important;
      font-weight: 500; color: var(--text-3); font-size: 11.5px;
      text-transform: uppercase; letter-spacing: 0.04em; min-width: 160px; }
    .dk-matrix .dk-th-opt { font-weight: 600; color: var(--text-1);
      background: var(--bg-0); border-left: 1px solid var(--border); }
    .dk-matrix .dk-th-opt.dk-winner { color: var(--accent); }
    .dk-matrix .dk-th-crit { text-align: left !important; font-weight: 500; color: var(--text-1); }
    .dk-matrix .dk-crit-label { display: inline-block; margin-right: 8px; }
    .dk-matrix .dk-weight { display: inline-flex; align-items: center; gap: 2px;
      padding: 1px 4px; border-radius: 4px; background: var(--bg-0);
      transition: background 200ms; }
    .dk-matrix .dk-weight.dk-flash { animation: dk-mtx-flash 600ms ease-out; }
    .dk-matrix .dk-weight::before { content: 'peso'; font-size: 10px;
      color: var(--text-3); font-family: var(--mono); margin-right: 3px; }
    .dk-matrix .dk-weight input { width: 32px; background: transparent; border: none;
      color: var(--accent); font: 600 12px var(--mono); text-align: center;
      -moz-appearance: textfield; appearance: textfield; }
    .dk-matrix .dk-weight input::-webkit-outer-spin-button,
    .dk-matrix .dk-weight input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .dk-matrix .dk-weight input:focus { outline: none; }
    .dk-matrix .dk-cell { border-left: 1px solid var(--border); transition: background 200ms; }
    .dk-matrix .dk-cell.dk-flash { animation: dk-mtx-flash 600ms ease-out; }
    .dk-matrix .dk-cell input { width: 50px; background: transparent;
      border: 1px solid transparent; border-radius: 3px; color: var(--text-1);
      font: 13px var(--mono); text-align: center; padding: 2px 4px;
      -moz-appearance: textfield; appearance: textfield; }
    .dk-matrix .dk-cell input::-webkit-outer-spin-button,
    .dk-matrix .dk-cell input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .dk-matrix .dk-cell input:hover { border-color: var(--border); }
    .dk-matrix .dk-cell input:focus { outline: none; border-color: var(--accent); background: var(--bg-0); }
    .dk-matrix .dk-cell input::placeholder { color: var(--text-3); }
    .dk-matrix tfoot th, .dk-matrix tfoot td { background: var(--bg-0);
      border-top: 2px solid var(--border); font-weight: 600; }
    .dk-matrix .dk-th-totals { text-align: left !important; color: var(--text-3);
      font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
    .dk-matrix .dk-total { border-left: 1px solid var(--border); color: var(--text-1);
      font: 14px var(--mono); transition: color 250ms; }
    .dk-matrix .dk-total.dk-winner { color: var(--accent); }
    .dk-matrix .dk-trophy { display: inline-block; margin-left: 4px;
      animation: dk-mtx-trophy 1.8s ease-in-out infinite; }
    .dk-matrix.dk-readonly .dk-cell input, .dk-matrix.dk-readonly .dk-weight input {
      cursor: not-allowed; color: var(--text-2); }
    .dk-matrix .dk-ai-badge { position: absolute; top: 8px; right: 10px;
      font: 600 9.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--accent); background: rgba(138,92,246,0.12);
      border: 1px solid rgba(138,92,246,0.35); border-radius: 3px;
      padding: 2px 6px; z-index: 2; cursor: help; }
    @keyframes dk-mtx-flash {
      0% { background: rgba(138,92,246,0.4); }
      100% { background: rgba(138,92,246,0); } }
    @keyframes dk-mtx-trophy {
      0%,100% { transform: translateY(0); }
      50% { transform: translateY(-2px); } }
  \`;
  h.injectOnce('matrix', CSS);

  function clampScore(n) {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 10) return 10;
    return Math.round(n * 10) / 10;
  }
  function clampWeight(n) {
    if (!Number.isFinite(n)) return 1;
    if (n < 1) return 1;
    if (n > 10) return 10;
    return Math.round(n);
  }
  function cellKey(o, c) { return o + '.' + c; }

  function render(container, spec) {
    const readonly = spec.readonly === true;
    container.className = 'dk-matrix' + (readonly ? ' dk-readonly' : '');
    container.innerHTML = '';
    if (readonly) {
      const badge = document.createElement('div');
      badge.className = 'dk-ai-badge';
      badge.title = 'Read-only: só a AI pode mutar';
      badge.textContent = 'AI-only';
      container.appendChild(badge);
    }

    const options = Array.isArray(spec.options) ? spec.options.filter((o) => o && typeof o.id === 'string' && typeof o.label === 'string') : [];
    const criteria = (Array.isArray(spec.criteria) ? spec.criteria : [])
      .filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string')
      .map((c) => ({ ...c, weight: clampWeight(typeof c.weight === 'number' ? c.weight : 3) }));

    // Inputs indexed for external op lookups (AI driving via card_invoke).
    const cellInputs = new Map(); // cellKey → <input>
    const weightInputs = new Map(); // criterionId → <input>
    const wrappers = new Map(); // for flash: 'w:<critId>' → wrap, cellKey → td

    if (options.length === 0 || criteria.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dk-matrix-empty';
      empty.textContent = 'add options + criteria';
      container.appendChild(empty);
      return;
    }

    // Persistence (per spec.id): merges over baseline scores.
    const key = spec.id ? 'dk-matrix:' + spec.id : null;
    let savedScores = {};
    let savedWeights = {};
    if (key && !readonly) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        savedScores = raw.scores || {};
        savedWeights = raw.weights || {};
      } catch (e) { /* ignore */ }
    }
    const scores = Object.assign({}, spec.scores || {}, savedScores);
    for (const c of criteria) {
      if (savedWeights[c.id] !== undefined) c.weight = clampWeight(savedWeights[c.id]);
    }
    function persist() {
      if (!key) return;
      const ws = {};
      for (const c of criteria) ws[c.id] = c.weight;
      localStorage.setItem(key, JSON.stringify({ scores, weights: ws }));
    }

    const table = document.createElement('table');
    container.appendChild(table);

    // Header.
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'dk-corner';
    corner.textContent = 'Critério (peso)';
    trh.appendChild(corner);
    const optHeaders = new Map();
    for (const o of options) {
      const th = document.createElement('th');
      th.className = 'dk-th-opt';
      th.textContent = o.label;
      trh.appendChild(th);
      optHeaders.set(o.id, th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    // Body.
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    for (const c of criteria) {
      const tr = document.createElement('tr');
      const thc = document.createElement('th');
      thc.className = 'dk-th-crit';
      const lbl = document.createElement('span');
      lbl.className = 'dk-crit-label';
      lbl.textContent = c.label;
      thc.appendChild(lbl);
      const wrap = document.createElement('span');
      wrap.className = 'dk-weight';
      const wInput = document.createElement('input');
      wInput.type = 'number';
      wInput.min = '1'; wInput.max = '10'; wInput.step = '1';
      wInput.value = String(c.weight);
      wInput.readOnly = readonly;
      wInput.setAttribute('aria-label', 'peso de ' + c.label);
      wInput.addEventListener('input', () => {
        if (readonly) return;
        const n = Number(wInput.value);
        if (!Number.isFinite(n)) return;
        c.weight = clampWeight(n);
        wInput.value = String(c.weight);
        flash(wrap);
        recompute();
        persist();
      });
      wrap.appendChild(wInput);
      thc.appendChild(wrap);
      tr.appendChild(thc);
      weightInputs.set(c.id, wInput);
      wrappers.set('w:' + c.id, wrap);
      for (const o of options) {
        const td = document.createElement('td');
        td.className = 'dk-cell';
        const cInput = document.createElement('input');
        cInput.type = 'number';
        cInput.min = '0'; cInput.max = '10'; cInput.step = '0.5';
        const k = cellKey(o.id, c.id);
        const v = scores[k];
        cInput.value = v === undefined ? '' : String(v);
        cInput.placeholder = '—';
        cInput.readOnly = readonly;
        cInput.setAttribute('aria-label', 'nota de ' + o.label + ' em ' + c.label);
        cInput.addEventListener('input', () => {
          if (readonly) return;
          const raw = cInput.value;
          if (raw === '') { delete scores[k]; }
          else {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            scores[k] = clampScore(n);
          }
          flash(td);
          recompute();
          persist();
        });
        td.appendChild(cInput);
        tr.appendChild(td);
        cellInputs.set(k, cInput);
        wrappers.set(k, td);
      }
      tbody.appendChild(tr);
    }

    // Footer (totals).
    const tfoot = document.createElement('tfoot');
    const trf = document.createElement('tr');
    const thTot = document.createElement('th');
    thTot.className = 'dk-th-totals';
    thTot.textContent = 'Score ponderado';
    trf.appendChild(thTot);
    const totalCells = new Map();
    const trophyEls = new Map();
    for (const o of options) {
      const th = document.createElement('th');
      th.className = 'dk-total';
      const val = document.createElement('span');
      val.className = 'dk-total-value';
      val.textContent = '0.0';
      th.appendChild(val);
      const trophy = document.createElement('span');
      trophy.className = 'dk-trophy';
      trophy.textContent = '🏆';
      trophy.style.display = 'none';
      th.appendChild(trophy);
      trf.appendChild(th);
      totalCells.set(o.id, val);
      trophyEls.set(o.id, { th, trophy });
    }
    tfoot.appendChild(trf);
    table.appendChild(tfoot);

    function recompute() {
      const totals = {};
      for (const o of options) {
        let sum = 0;
        for (const c of criteria) {
          const s = scores[cellKey(o.id, c.id)];
          if (typeof s === 'number') sum += s * c.weight;
        }
        totals[o.id] = Math.round(sum * 10) / 10;
      }
      let winnerId = null;
      let max = -Infinity;
      for (const o of options) {
        if (totals[o.id] > max) { max = totals[o.id]; winnerId = o.id; }
      }
      for (const o of options) {
        const cell = totalCells.get(o.id);
        cell.textContent = totals[o.id].toFixed(1);
        const isWin = o.id === winnerId && options.length > 1;
        const oh = optHeaders.get(o.id);
        const { th, trophy } = trophyEls.get(o.id);
        if (isWin) { oh.classList.add('dk-winner'); th.classList.add('dk-winner'); trophy.style.display = ''; }
        else { oh.classList.remove('dk-winner'); th.classList.remove('dk-winner'); trophy.style.display = 'none'; }
      }
    }
    recompute();

    function flash(el) {
      el.classList.remove('dk-flash');
      void el.offsetWidth;
      el.classList.add('dk-flash');
      setTimeout(() => el.classList.remove('dk-flash'), 600);
    }

    // Register imperative ops with the bridge — only when the spec has an id.
    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      const totals = () => {
        const t = {};
        for (const o of options) {
          let sum = 0;
          for (const c of criteria) {
            const s = scores[cellKey(o.id, c.id)];
            if (typeof s === 'number') sum += s * c.weight;
          }
          t[o.id] = Math.round(sum * 10) / 10;
        }
        return t;
      };
      window.__deckyRegisterWidget(spec.id, {
        type: 'matrix',
        ops: {
          setScore: (args) => {
            const a = args || {};
            const oId = a.optionId, cId = a.criterionId;
            if (!oId || !cId) throw new Error('setScore: optionId + criterionId required');
            if (typeof a.value !== 'number') throw new Error('setScore: value (number) required');
            const k = cellKey(oId, cId);
            const v = clampScore(a.value);
            scores[k] = v;
            const inp = cellInputs.get(k);
            if (inp) inp.value = String(v);
            const td = wrappers.get(k);
            if (td) flash(td);
            recompute(); persist();
            return { ok: true, value: v };
          },
          setWeight: (args) => {
            const a = args || {};
            if (!a.criterionId) throw new Error('setWeight: criterionId required');
            if (typeof a.weight !== 'number') throw new Error('setWeight: weight required');
            const w = clampWeight(a.weight);
            const c = criteria.find((x) => x.id === a.criterionId);
            if (!c) throw new Error('setWeight: criterion not found: ' + a.criterionId);
            c.weight = w;
            const inp = weightInputs.get(c.id);
            if (inp) inp.value = String(w);
            const wrap = wrappers.get('w:' + c.id);
            if (wrap) flash(wrap);
            recompute(); persist();
            return { ok: true, weight: w };
          }
        },
        getters: {
          totals,
          ranking: () => {
            const t = totals();
            return options.map((o) => o.id).sort((a, b) => (t[b] || 0) - (t[a] || 0));
          },
          winner: () => {
            const t = totals();
            const sorted = options.map((o) => o.id).sort((a, b) => (t[b] || 0) - (t[a] || 0));
            return sorted[0] || null;
          }
        }
      });
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-matrix]').forEach((el) => {
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

const ROADMAP_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-roadmap { position: relative; margin: 1em 0; padding: 14px;
      background: var(--bg-1); border: 1px solid var(--border); border-radius: 8px; }
    .dk-roadmap .dk-rm-empty { color: var(--text-3); font: 12px var(--mono); text-align: center; }
    .dk-roadmap .dk-rm-progress { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .dk-roadmap .dk-rm-track { flex: 1; height: 6px; background: var(--bg-0);
      border-radius: 3px; overflow: hidden; }
    .dk-roadmap .dk-rm-fill { height: 100%;
      background: linear-gradient(90deg, var(--accent), rgba(138,92,246,0.6));
      border-radius: 3px; transition: width 400ms ease; }
    .dk-roadmap .dk-rm-pct { font: 11.5px var(--mono); color: var(--text-3); white-space: nowrap; }
    .dk-roadmap .dk-rm-timeline { display: flex; align-items: stretch; gap: 0;
      overflow-x: auto; padding: 8px 4px 4px 4px; }
    .dk-roadmap .dk-rm-ms { position: relative; display: flex; flex-direction: column;
      align-items: center; text-align: center; min-width: 120px; padding: 6px 10px 10px 10px;
      border-radius: 6px; transition: background 200ms; }
    .dk-roadmap .dk-rm-ms.dk-flash { animation: dk-rm-flash 600ms ease-out; }
    .dk-roadmap .dk-rm-conn { position: absolute; left: -2px; top: 22px; width: 40px;
      height: 2px; background: var(--border); transform: translateX(-100%); }
    .dk-roadmap .dk-rm-ms.dk-status-done .dk-rm-conn { background: var(--accent); }
    .dk-roadmap .dk-rm-btn { background: transparent; border: none; cursor: pointer;
      padding: 0; margin-bottom: 6px; }
    .dk-roadmap .dk-rm-icon { font-size: 22px; line-height: 1;
      display: inline-block; transition: transform 200ms; }
    .dk-roadmap .dk-rm-ms.dk-status-in_progress .dk-rm-icon {
      animation: dk-rm-pulse 1.6s ease-in-out infinite; }
    .dk-roadmap .dk-rm-btn:hover .dk-rm-icon { transform: scale(1.15); }
    .dk-roadmap.dk-readonly .dk-rm-btn { cursor: not-allowed; }
    .dk-roadmap.dk-readonly .dk-rm-btn:hover .dk-rm-icon { transform: none; }
    .dk-roadmap .dk-rm-label { font: 600 13px var(--sans); color: var(--text-1);
      margin-bottom: 4px; line-height: 1.3; }
    .dk-roadmap .dk-rm-ms.dk-status-done .dk-rm-label { opacity: 0.7;
      text-decoration: line-through; text-decoration-color: var(--text-3); }
    .dk-roadmap .dk-rm-ms.dk-blocked .dk-rm-label { color: var(--text-3); }
    .dk-roadmap .dk-rm-date { font: 10.5px var(--mono); color: var(--text-3);
      text-transform: uppercase; letter-spacing: 0.04em; }
    .dk-roadmap .dk-rm-deps { margin-top: 6px; font-size: 10.5px; color: var(--text-3);
      font-style: italic; max-width: 140px; line-height: 1.3; }
    .dk-roadmap .dk-ai-badge { position: absolute; top: 8px; right: 10px;
      font: 600 9.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--accent); background: rgba(138,92,246,0.12);
      border: 1px solid rgba(138,92,246,0.35); border-radius: 3px;
      padding: 2px 6px; z-index: 2; cursor: help; }
    @keyframes dk-rm-flash {
      0% { background: rgba(138,92,246,0.32); }
      100% { background: rgba(138,92,246,0); } }
    @keyframes dk-rm-pulse {
      0%,100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(138,92,246,0)); }
      50% { transform: scale(1.12); filter: drop-shadow(0 0 6px rgba(138,92,246,0.65)); } }
  \`;
  h.injectOnce('roadmap', CSS);

  const STATUSES = ['todo', 'in_progress', 'done'];
  function isStatus(s) { return s === 'todo' || s === 'in_progress' || s === 'done'; }
  function cycle(s) { return STATUSES[(STATUSES.indexOf(s) + 1) % STATUSES.length]; }
  function statusIcon(s, blocked) {
    if (blocked) return '⛔';
    if (s === 'done') return '✅';
    if (s === 'in_progress') return '🟡';
    return '⏳';
  }
  function shortDate(d) {
    if (!d) return '';
    const parts = String(d).split('-');
    if (parts.length !== 3) return d;
    const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const m = parseInt(parts[1], 10) - 1;
    return parts[2] + ' ' + (months[m] || parts[1]) + '/' + parts[0].slice(2);
  }

  function render(container, spec) {
    const readonly = spec.readonly === true;
    container.className = 'dk-roadmap' + (readonly ? ' dk-readonly' : '');
    container.innerHTML = '';
    if (readonly) {
      const badge = document.createElement('div');
      badge.className = 'dk-ai-badge';
      badge.title = 'Read-only: só a AI pode mutar';
      badge.textContent = 'AI-only';
      container.appendChild(badge);
    }

    const milestones = (Array.isArray(spec.milestones) ? spec.milestones : [])
      .filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string')
      .map((m) => ({
        id: m.id, label: m.label,
        date: typeof m.date === 'string' ? m.date : undefined,
        status: isStatus(m.status) ? m.status : 'todo',
        deps: Array.isArray(m.deps) ? m.deps.filter((d) => typeof d === 'string') : []
      }));
    if (milestones.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dk-rm-empty';
      empty.textContent = 'no milestones';
      container.appendChild(empty);
      return;
    }

    // Persistence (status overrides by milestone id).
    const key = spec.id ? 'dk-roadmap:' + spec.id : null;
    let saved = {};
    if (key && !readonly) {
      try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
    }
    for (const m of milestones) {
      if (saved[m.id] && isStatus(saved[m.id])) m.status = saved[m.id];
    }
    function persist() {
      if (!key) return;
      const s = {};
      for (const m of milestones) s[m.id] = m.status;
      localStorage.setItem(key, JSON.stringify(s));
    }

    // Sort by date.
    const sorted = milestones.slice().sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
    const labelById = {};
    for (const m of milestones) labelById[m.id] = m.label;

    // Progress header.
    const prog = document.createElement('div');
    prog.className = 'dk-rm-progress';
    const track = document.createElement('div');
    track.className = 'dk-rm-track';
    const fill = document.createElement('div');
    fill.className = 'dk-rm-fill';
    track.appendChild(fill);
    prog.appendChild(track);
    const pct = document.createElement('div');
    pct.className = 'dk-rm-pct';
    prog.appendChild(pct);
    container.appendChild(prog);

    // Timeline.
    const tl = document.createElement('div');
    tl.className = 'dk-rm-timeline';
    container.appendChild(tl);

    const msEls = new Map();
    const iconEls = new Map();
    sorted.forEach((m, idx) => {
      const div = document.createElement('div');
      div.className = 'dk-rm-ms dk-status-' + m.status;
      if (idx > 0) {
        const conn = document.createElement('div');
        conn.className = 'dk-rm-conn';
        div.appendChild(conn);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dk-rm-btn';
      btn.disabled = readonly;
      const icon = document.createElement('span');
      icon.className = 'dk-rm-icon';
      btn.appendChild(icon);
      div.appendChild(btn);
      const lbl = document.createElement('div');
      lbl.className = 'dk-rm-label';
      lbl.textContent = m.label;
      div.appendChild(lbl);
      if (m.date) {
        const dt = document.createElement('div');
        dt.className = 'dk-rm-date';
        dt.textContent = shortDate(m.date);
        div.appendChild(dt);
      }
      if (m.deps.length > 0) {
        const deps = document.createElement('div');
        deps.className = 'dk-rm-deps';
        deps.textContent = '← ' + m.deps.map((d) => labelById[d] || d).join(', ');
        div.appendChild(deps);
      }
      btn.addEventListener('click', () => {
        if (readonly) return;
        m.status = cycle(m.status);
        flash(div);
        update();
        persist();
      });
      tl.appendChild(div);
      msEls.set(m.id, div);
      iconEls.set(m.id, icon);
    });

    function update() {
      const doneIds = new Set();
      let done = 0;
      for (const m of milestones) { if (m.status === 'done') { doneIds.add(m.id); done++; } }
      const total = milestones.length;
      const percent = total === 0 ? 0 : Math.round((done / total) * 100);
      fill.style.width = percent + '%';
      pct.textContent = done + '/' + total + ' (' + percent + '%)';
      for (const m of milestones) {
        const el = msEls.get(m.id);
        const icon = iconEls.get(m.id);
        const blocked = m.status === 'todo' && m.deps.some((d) => !doneIds.has(d));
        el.className = 'dk-rm-ms dk-status-' + m.status + (blocked ? ' dk-blocked' : '');
        icon.textContent = statusIcon(m.status, blocked);
        const tip = readonly
          ? 'Status: ' + m.status + (blocked ? ' (deps pendentes)' : '') + ' — read-only'
          : 'Status: ' + m.status + (blocked ? ' (deps pendentes)' : '') + ' — clique pra alternar';
        el.querySelector('.dk-rm-btn').title = tip;
      }
    }
    update();

    function flash(el) {
      el.classList.remove('dk-flash');
      void el.offsetWidth;
      el.classList.add('dk-flash');
      setTimeout(() => el.classList.remove('dk-flash'), 600);
    }

    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'roadmap',
        ops: {
          setStatus: (args) => {
            const a = args || {};
            if (!a.id) throw new Error('setStatus: id required');
            if (!isStatus(a.status)) throw new Error('setStatus: status must be todo|in_progress|done');
            const m = milestones.find((x) => x.id === a.id);
            if (!m) throw new Error('setStatus: milestone not found: ' + a.id);
            m.status = a.status;
            const el = msEls.get(a.id);
            if (el) flash(el);
            update(); persist();
            return { ok: true, status: a.status };
          },
          setDate: (args) => {
            const a = args || {};
            if (!a.id || !a.date) throw new Error('setDate: id + date required');
            const m = milestones.find((x) => x.id === a.id);
            if (!m) throw new Error('setDate: milestone not found: ' + a.id);
            m.date = a.date;
            // Date updates affect sort order; for MVP just re-render to keep timeline consistent.
            render(container, { ...spec, milestones: milestones.map((mm) => ({ ...mm })) });
            return { ok: true };
          }
        },
        getters: {
          milestones: () => milestones.slice(),
          progress: () => {
            const done = milestones.filter((m) => m.status === 'done').length;
            const total = milestones.length;
            return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
          },
          nextMilestone: () => {
            const doneIds = new Set(milestones.filter((m) => m.status === 'done').map((m) => m.id));
            return sorted.find((m) => m.status === 'todo' && m.deps.every((d) => doneIds.has(d))) || null;
          }
        }
      });
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-roadmap]').forEach((el) => {
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

// toc — sumário (table of contents) auto-gerado. Varre a página por headings (.dk-title e os
// h1/h2/h3 dos blocos .dk-text), monta uma nav clicável com scroll suave, ancora os headings que
// não têm id (slug do texto) e destaca a seção ativa via IntersectionObserver (scroll-spy). Como
// os blocos de text renderizam markdown async e o agente pode adicionar seções depois, um
// MutationObserver re-varre e reconstrói quando a lista de headings muda. spec:
// { id, title?, levels?: [1,2,3], sticky?, items?: [{text, level, target}] }. Em modo `items`
// explícito, usa a lista dada (targets = ids já existentes) e não auto-ancora nada.
const TOC_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  const CSS = \`
    .dk-toc { margin: 1em 0; padding: 12px 14px; background: var(--bg-1);
      border: 1px solid var(--border); border-radius: 8px; font: 13px var(--sans); }
    .dk-toc.dk-sticky { position: sticky; top: 12px; align-self: flex-start; }
    .dk-toc .dk-toc-head { font: 600 10.5px var(--mono); letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--text-3); margin-bottom: 8px; }
    .dk-toc ul { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--border); }
    .dk-toc li { margin: 0; }
    .dk-toc a { display: block; padding: 3px 10px; color: var(--text-2); text-decoration: none;
      line-height: 1.4; border-left: 2px solid transparent; margin-left: -2px;
      transition: color 120ms, border-color 120ms, background 120ms;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dk-toc a:hover { color: var(--text-0, var(--text-1)); background: var(--bg-0); }
    .dk-toc a.dk-lvl2 { padding-left: 22px; font-size: 12.5px; }
    .dk-toc a.dk-lvl3 { padding-left: 34px; font-size: 12px; color: var(--text-3); }
    .dk-toc a.dk-active { color: var(--accent); border-left-color: var(--accent);
      background: rgba(138,92,246,0.08); font-weight: 600; }
    .dk-toc .dk-toc-empty { color: var(--text-3); font: 11.5px var(--mono); }
  \`;
  h.injectOnce('toc', CSS);

  function slugify(s) {
    return (String(s || '').toLowerCase().trim()
      .replace(/[^\\w\\s-]/g, '').replace(/\\s+/g, '-').slice(0, 60)) || 'sec';
  }

  function levelOf(node) {
    if (node.classList && node.classList.contains('dk-title')) {
      const a = parseInt(node.getAttribute('aria-level') || '1', 10);
      return a >= 1 && a <= 3 ? a : 1;
    }
    const t = node.tagName;
    return t === 'H2' ? 2 : t === 'H3' ? 3 : 1;
  }

  // Varre o DOM por headings, ancorando (id) os que não têm. Não conta os headings DENTRO de
  // outro TOC (não há, mas o seletor é específico de títulos reais).
  function collect(levels) {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('.dk-title, .dk-text h1, .dk-text h2, .dk-text h3').forEach((node) => {
      const text = (node.textContent || '').trim();
      if (!text) return;
      const lvl = levelOf(node);
      if (levels.indexOf(lvl) === -1) return;
      if (!node.id) {
        const base = slugify(text);
        let id = base, n = 2;
        while (document.getElementById(id) || seen.has(id)) id = base + '-' + (n++);
        node.id = id;
      }
      seen.add(node.id);
      node.style.scrollMarginTop = '14px';
      out.push({ text, level: lvl, target: node.id });
    });
    return out;
  }

  function render(container, spec) {
    const levels = Array.isArray(spec.levels) && spec.levels.length
      ? spec.levels.map(Number).filter((n) => n >= 1 && n <= 3)
      : [1, 2, 3];
    const explicit = Array.isArray(spec.items) && spec.items.length > 0;
    container.className = 'dk-toc' + (spec.sticky ? ' dk-sticky' : '');
    const anchorByTarget = new Map();
    let observer = null;

    function items() {
      if (explicit) {
        return spec.items.map((it) => ({
          text: String(it.text || ''),
          level: Math.min(3, Math.max(1, Number(it.level) || 1)),
          target: String(it.target || it.href || '').replace(/^#/, '')
        }));
      }
      return collect(levels);
    }

    function build() {
      const list = items();
      container.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'dk-toc-head';
      head.textContent = typeof spec.title === 'string' ? spec.title : 'Conteúdo';
      container.appendChild(head);
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'dk-toc-empty';
        e.textContent = 'sem seções ainda';
        container.appendChild(e);
        return list;
      }
      const ul = document.createElement('ul');
      anchorByTarget.clear();
      list.forEach((it) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'dk-lvl' + it.level;
        a.textContent = it.text;
        a.href = '#' + it.target;
        a.addEventListener('click', (ev) => {
          const tgt = it.target && document.getElementById(it.target);
          if (tgt) {
            ev.preventDefault();
            tgt.scrollIntoView({ behavior: 'smooth', block: 'start' });
            try { history.replaceState(null, '', '#' + it.target); } catch (e) {}
          }
        });
        anchorByTarget.set(it.target, a);
        li.appendChild(a);
        ul.appendChild(li);
      });
      container.appendChild(ul);
      spy(list);
      return list;
    }

    // Scroll-spy: marca como ativo o heading mais visível no topo do viewport.
    function spy(list) {
      if (observer) { observer.disconnect(); observer = null; }
      if (!('IntersectionObserver' in window)) return;
      const visible = new Map();
      observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) visible.set(en.target.id, en.intersectionRatio);
          else visible.delete(en.target.id);
        });
        let bestId = null, best = -1;
        visible.forEach((r, id) => { if (r > best) { best = r; bestId = id; } });
        if (!bestId) return;
        anchorByTarget.forEach((a) => a.classList.remove('dk-active'));
        const a = anchorByTarget.get(bestId);
        if (a) a.classList.add('dk-active');
      }, { rootMargin: '0px 0px -65% 0px', threshold: [0, 1] });
      list.forEach((it) => {
        const el = it.target && document.getElementById(it.target);
        if (el) observer.observe(el);
      });
    }

    let current = build();

    // Re-varre quando o DOM muda (blocos text renderizam md async; agente pode somar seções).
    // Debounce + guard de igualdade ⇒ a própria reconstrução não dispara loop (na 2ª passada
    // collect == current). Não observa attributes, então setar id/style nos headings não conta.
    if (!explicit) {
      let timer = null;
      const mo = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          const next = collect(levels);
          const changed = next.length !== current.length ||
            next.some((it, i) => !current[i] || current[i].text !== it.text || current[i].level !== it.level);
          if (changed) current = build();
        }, 140);
      });
      const root = container.closest('.dk-card-widgets') || document.body;
      mo.observe(root, { childList: true, subtree: true, characterData: true });
    }

    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'toc',
        ops: {
          refresh: () => { current = build(); return { ok: true, count: current.length }; }
        },
        getters: {
          items: () => current.map((it) => ({ text: it.text, level: it.level, target: it.target }))
        }
      });
    }
  }

  function initAll() {
    document.querySelectorAll('[data-decky-toc]').forEach((el) => {
      if (el.dataset.deckyInit) return;
      el.dataset.deckyInit = '1';
      const spec = h.parseSpec(el);
      const nav = document.createElement('nav');
      el.replaceWith(nav);
      render(nav, spec);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
`

// kpi — grid de indicadores. spec: { id, items: [{ value, label, delta? }] }. delta colorido por
// sinal (começa com '-' ou '↓' = baixa/vermelho; senão alta/verde). Op setItems / getter items.
const KPI_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('kpi', \`
    .dk-kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px; margin: 1em 0; }
    .dk-kpi .cell { background: var(--bg-1); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px 16px; }
    .dk-kpi .num { font-size: 26px; font-weight: 800; color: var(--accent);
      letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .dk-kpi .lab { font-size: 12px; color: var(--text-2); margin-top: 3px; }
    .dk-kpi .delta { font-size: 12px; font-weight: 600; margin-top: 4px;
      font-variant-numeric: tabular-nums; }
    .dk-kpi .delta.up { color: #34d399; } .dk-kpi .delta.down { color: #fb7185; }
  \`);
  function render(el, spec) {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const grid = document.createElement('div');
    grid.className = 'dk-kpi';
    for (const it of items) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = it.value != null ? String(it.value) : '';
      const lab = document.createElement('div');
      lab.className = 'lab';
      lab.textContent = it.label || '';
      cell.appendChild(num); cell.appendChild(lab);
      if (it.delta != null && it.delta !== '') {
        const d = document.createElement('div');
        const s = String(it.delta);
        const down = /^[-↓]/.test(s.trim());
        d.className = 'delta ' + (down ? 'down' : 'up');
        d.textContent = s;
        cell.appendChild(d);
      }
      grid.appendChild(cell);
    }
    el.replaceWith(grid);
    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'kpi',
        ops: { setItems: (a) => { spec.items = (a && a.items) || []; const n = grid.cloneNode(false);
          grid.replaceWith(n); render(n, spec); return { ok: true }; } },
        getters: { items: () => items }
      });
    }
  }
  function initAll() {
    document.querySelectorAll('[data-decky-kpi]').forEach((el) => {
      if (el.dataset.deckyInit) return; el.dataset.deckyInit = '1';
      render(el, h.parseSpec(el));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`

// callout — caixa de destaque. spec: { id, tone?: 'info'|'tip'|'warn'|'danger', title?, text }.
const CALLOUT_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('callout', \`
    .dk-callout { border-left: 3px solid var(--accent); background: var(--bg-1);
      border-radius: 8px; padding: 12px 14px; margin: 1em 0; }
    .dk-callout .ttl { font-weight: 650; margin-bottom: 4px; display: flex; gap: 7px; align-items: center; }
    .dk-callout .ico { font-size: 14px; }
    .dk-callout .body { color: var(--text-2); white-space: pre-wrap; }
    .dk-callout.tip { border-left-color: #34d399; }
    .dk-callout.warn { border-left-color: #fbbf24; }
    .dk-callout.danger { border-left-color: #fb7185; }
  \`);
  const ICON = { info: 'ℹ️', tip: '💡', warn: '⚠️', danger: '🛑' };
  function render(el, spec) {
    const tone = ['info','tip','warn','danger'].includes(spec.tone) ? spec.tone : 'info';
    const box = document.createElement('div');
    box.className = 'dk-callout ' + tone;
    if (spec.title) {
      const t = document.createElement('div'); t.className = 'ttl';
      const ic = document.createElement('span'); ic.className = 'ico'; ic.textContent = ICON[tone];
      const tx = document.createElement('span'); tx.textContent = spec.title;
      t.appendChild(ic); t.appendChild(tx); box.appendChild(t);
    }
    const body = document.createElement('div'); body.className = 'body';
    body.textContent = spec.text || '';
    box.appendChild(body);
    el.replaceWith(box);
  }
  function initAll() {
    document.querySelectorAll('[data-decky-callout]').forEach((el) => {
      if (el.dataset.deckyInit) return; el.dataset.deckyInit = '1';
      render(el, h.parseSpec(el));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`

// table — tabela estilizada. spec: { id, headers: [string], rows: [[cell]], align?: ['left'|'right'] }.
// Células que começam com '+' ficam verdes e '-' vermelhas (deltas). Op setRows / getter rows.
const TABLE_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('table', \`
    .dk-table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 14px; }
    .dk-table th, .dk-table td { text-align: left; padding: 9px 12px;
      border-bottom: 1px solid var(--border); }
    .dk-table th { color: var(--text-2); font-weight: 600; font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.06em; }
    .dk-table td.r, .dk-table th.r { text-align: right; font-variant-numeric: tabular-nums; }
    .dk-table tr:last-child td { border-bottom: none; }
    .dk-table .pos { color: #34d399; } .dk-table .neg { color: #fb7185; }
  \`);
  function render(el, spec) {
    const headers = Array.isArray(spec.headers) ? spec.headers : [];
    const rows = Array.isArray(spec.rows) ? spec.rows : [];
    const align = Array.isArray(spec.align) ? spec.align : [];
    const cls = (i) => (align[i] === 'right' ? ' class="r"' : '');
    const thead = headers.length
      ? '<thead><tr>' + headers.map((hh, i) => '<th' + cls(i) + '>' + esc(hh) + '</th>').join('') + '</tr></thead>'
      : '';
    const tbody = '<tbody>' + rows.map((r) => '<tr>' + (Array.isArray(r) ? r : []).map((c, i) => {
      const s = c == null ? '' : String(c);
      const tone = /^\\+/.test(s.trim()) ? ' pos' : /^-/.test(s.trim()) ? ' neg' : '';
      const a = align[i] === 'right' ? ' r' : '';
      const klass = (tone || a) ? ' class="' + (a + tone).trim() + '"' : '';
      return '<td' + klass + '>' + esc(s) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody>';
    const tbl = document.createElement('table');
    tbl.className = 'dk-table';
    tbl.innerHTML = thead + tbody;
    el.replaceWith(tbl);
    if (spec.id && typeof window.__deckyRegisterWidget === 'function') {
      window.__deckyRegisterWidget(spec.id, {
        type: 'table',
        ops: { setRows: (a) => { spec.rows = (a && a.rows) || []; const n = document.createElement('table');
          tbl.replaceWith(n); render(n, spec); return { ok: true }; } },
        getters: { rows: () => rows }
      });
    }
  }
  function esc(s) { return String(s).replace(/[<>&]/g, (c) => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'); }
  function initAll() {
    document.querySelectorAll('[data-decky-table]').forEach((el) => {
      if (el.dataset.deckyInit) return; el.dataset.deckyInit = '1';
      render(el, h.parseSpec(el));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`

// columns — layout multi-coluna. spec: { id, cols: ["md", "md", ...] }. Cada coluna renderiza
// markdown (via marked); empilha em telas estreitas.
const COLUMNS_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('columns', \`
    .dk-columns { display: grid; gap: 18px; margin: 1em 0;
      grid-template-columns: repeat(var(--n, 2), 1fr); }
    @media (max-width: 640px) { .dk-columns { grid-template-columns: 1fr; } }
    .dk-columns > div > :first-child { margin-top: 0; }
  \`);
  let markedP = null;
  function loadMarked() { if (!markedP) markedP = import('${MARKED_URL}').then((m) => m.marked); return markedP; }
  function render(el, spec) {
    const cols = Array.isArray(spec.cols) ? spec.cols : [];
    const row = document.createElement('div');
    row.className = 'dk-columns';
    row.style.setProperty('--n', String(Math.max(1, cols.length)));
    const cells = cols.map((md) => { const d = document.createElement('div'); d.textContent = md || ''; row.appendChild(d); return { d, md: md || '' }; });
    el.replaceWith(row);
    loadMarked().then((marked) => { for (const c of cells) { try { c.d.innerHTML = marked.parse(c.md, { gfm: true }); } catch (e) {} } }).catch(() => {});
  }
  function initAll() {
    document.querySelectorAll('[data-decky-columns]').forEach((el) => {
      if (el.dataset.deckyInit) return; el.dataset.deckyInit = '1';
      render(el, h.parseSpec(el));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`

// divider — separador. spec: {} (sem campos).
const DIVIDER_JS =
  WIDGET_HELPERS_JS +
  `
(() => {
  const h = window.__deckyHelpers;
  h.injectOnce('divider', '.dk-divider { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }');
  function initAll() {
    document.querySelectorAll('[data-decky-divider]').forEach((el) => {
      if (el.dataset.deckyInit) return; el.dataset.deckyInit = '1';
      const hr = document.createElement('hr'); hr.className = 'dk-divider'; el.replaceWith(hr);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`

// MCP widget bridge — opens a WS to the decky-server, listens for `widget:call` broadcasts,
// dispatches to widgets registered via `window.__deckyRegisterWidget(widgetId, {type, ops, getters})`,
// and sends back `widget:call-reply`. Only handles calls whose cardId matches THIS page's cardId
// (derived from window.location.pathname). The React renderer is on the same WS channel and
// races for the reply — first reply wins, both honor reqId. Vanilla widgets and React widgets
// have distinct (cardId, widgetId) keys in practice, so no real conflict.
//
// `window.__deckyCardId` may be set by the server when known (preferred). Falls back to deriving
// from the URL: /path/to/foo.html → "path/to/foo".
const BRIDGE_JS = `
(() => {
  if (window.__deckyBridge) return;
  const registry = new Map(); // widgetId → { type, ops, getters }

  function deriveCardId() {
    if (typeof window.__deckyCardId === 'string') return window.__deckyCardId;
    try {
      const p = window.location.pathname.replace(/^\\/+/, '').replace(/\\.html?$/i, '');
      return decodeURIComponent(p);
    } catch (e) { return ''; }
  }
  const cardId = deriveCardId();

  function resolveWsUrl() {
    if (typeof window.__deckyWsUrl === 'string') return window.__deckyWsUrl;
    const proto = window.location.protocol;
    if (proto === 'http:' || proto === 'https:') {
      return (proto === 'https:' ? 'wss://' : 'ws://') + window.location.host;
    }
    // Fallback for card:// origins — assume default preview port. Server overrides via injection.
    return 'ws://127.0.0.1:6790';
  }

  let ws = null;
  let reconnectTimer = null;
  function connect() {
    const url = resolveWsUrl();
    if (!url) return;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || msg.v !== 1 || msg.kind !== 'widget:call') return;
      const p = msg.args || {};
      // Filter: only respond to calls targeting THIS card. Empty cardId in payload = "any".
      if (p.cardId && p.cardId !== cardId) return;
      handle(p);
    });
    ws.addEventListener('close', () => { ws = null; scheduleReconnect(); });
    ws.addEventListener('error', () => { try { ws && ws.close(); } catch {} });
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
  }

  function sendReply(reqId, result, error) {
    if (!ws || ws.readyState !== 1) return;
    const payload = { v: 1, kind: 'widget:call-reply', args: { reqId, result, error } };
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  async function handle(p) {
    const reqId = p.reqId;
    try {
      if (p.kind === 'list') {
        const out = [];
        for (const [widgetId, w] of registry.entries()) {
          out.push({ cardId, widgetId, type: w.type });
        }
        return sendReply(reqId, out);
      }
      if (!p.widgetId) return sendReply(reqId, undefined, 'widgetId required');
      const w = registry.get(p.widgetId);
      if (!w) {
        // Not ours — stay silent so the renderer side (if registered) can respond.
        return;
      }
      if (p.kind === 'invoke') {
        if (!p.op) return sendReply(reqId, undefined, 'op required');
        const fn = w.ops && w.ops[p.op];
        if (!fn) return sendReply(reqId, undefined, 'op not found: ' + p.op);
        const r = await fn(p.args);
        return sendReply(reqId, r);
      }
      if (p.kind === 'get') {
        if (!p.key) return sendReply(reqId, undefined, 'key required');
        const fn = w.getters && w.getters[p.key];
        if (!fn) return sendReply(reqId, undefined, 'getter not found: ' + p.key);
        const r = await fn();
        return sendReply(reqId, r);
      }
      sendReply(reqId, undefined, 'unknown kind: ' + p.kind);
    } catch (e) {
      sendReply(reqId, undefined, (e && e.message) || String(e));
    }
  }

  window.__deckyRegisterWidget = function (widgetId, info) {
    if (!widgetId || !info) return () => {};
    const entry = {
      type: info.type || '',
      ops: info.ops || {},
      getters: info.getters || {}
    };
    registry.set(widgetId, entry);
    return () => {
      if (registry.get(widgetId) === entry) registry.delete(widgetId);
    };
  };
  // Live patch (NO reload → no flicker): build & append a single widget from its spec, or pop
  // the last one. The card already carries every widget runtime, so we drop the div in and (re)load
  // the type's script with a cache-bust — its idempotent initAll (deckyInit guard) inits ONLY the
  // new div, leaving the already-rendered widgets (and their state) untouched. Used while a card is
  // built/torn down widget-by-widget; the manifest on disk stays the source of truth.
  window.__deckyAppendWidget = function (type, id, spec) {
    const container = document.querySelector('.dk-card-widgets');
    if (!container || !type) return;
    spec = spec || {};
    // Two CSS tricks so a widget appears smoothly, never showing its raw JSON:
    //  - .dk-pending: hide the placeholder until its runtime sets data-decky-init (every widget does
    //    so BEFORE rendering). So the JSON spec in textContent never paints, and the slot stays
    //    collapsed (no layout) until there's real content → siblings shift exactly once.
    //  - .dk-appended: a wrapper that fades+rises in. It works for BOTH render styles — replace-in
    //    widgets (text/title) swap the placeholder for a fresh node INSIDE this wrapper; fill-in
    //    widgets (checklist) fill the placeholder in place. Either way the wrapper is what we fade.
    if (!document.getElementById('dk-pending-style')) {
      const st = document.createElement('style');
      st.id = 'dk-pending-style';
      st.textContent =
        '.dk-pending:not([data-decky-init]){display:none!important}' +
        '.dk-appended{opacity:0;transform:translateY(4px);' +
        'transition:opacity 260ms ease,transform 260ms ease}' +
        '.dk-appended.dk-shown{opacity:1;transform:none}' +
        '.dk-appended.dk-leaving{opacity:0!important;transform:translateY(4px)!important}';
      document.head.appendChild(st);
    }
    const wrap = document.createElement('div');
    wrap.className = 'dk-appended';
    const div = document.createElement('div');
    div.className = 'dk-pending';
    div.setAttribute('data-decky-' + type, '');
    if (id) div.setAttribute('data-decky-wid', id);
    // Same shape renderManifest emits: mermaid reads raw text, others a JSON spec from textContent.
    div.textContent =
      type === 'mermaid'
        ? String(spec.src || spec.code || '')
        : JSON.stringify(Object.assign({ id: id }, spec));
    wrap.appendChild(div);
    container.appendChild(wrap);
    const s = document.createElement('script');
    s.src = '/__decky/widgets/' + type + '.js?t=' + Date.now();
    // onload = the widget script ran (initAll rendered it). Two rAFs ensure the browser has painted
    // the hidden start state before we flip to .dk-shown, so the transition actually animates.
    s.onload = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          wrap.classList.add('dk-shown');
        });
      });
    };
    document.head.appendChild(s);
  };
  window.__deckyPopWidget = function (n) {
    n = Math.max(1, (n | 0) || 1);
    const container = document.querySelector('.dk-card-widgets');
    if (!container) return;
    // Collect the last n elements UP FRONT — fading out leaves them in the DOM briefly, so reading
    // lastElementChild in a loop would re-grab the same node. Appended widgets fade out (.dk-leaving
    // → removed after the transition); plain ones (full-render) just go.
    const victims = [];
    let el = container.lastElementChild;
    while (el && victims.length < n) {
      victims.push(el);
      el = el.previousElementSibling;
    }
    victims.forEach(function (node) {
      if (node.classList.contains('dk-appended')) {
        node.classList.remove('dk-shown');
        node.classList.add('dk-leaving');
        setTimeout(function () {
          node.remove();
        }, 260);
      } else {
        node.remove();
      }
    });
  };
  window.__deckyBridge = { cardId, registry };
  connect();
})();
`

// Virtual routes — paths served from inline strings, not from disk.
const VIRTUAL_ROUTES: Record<string, { body: string; mime: string }> = {
  '/__decky/widgets/bridge.js': { body: BRIDGE_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/title.js': { body: TITLE_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/text.js': { body: TEXT_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/kpi.js': { body: KPI_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/callout.js': { body: CALLOUT_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/table.js': { body: TABLE_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/columns.js': { body: COLUMNS_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/divider.js': { body: DIVIDER_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/toc.js': { body: TOC_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/flow.js': { body: FLOW_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/checklist.js': {
    body: CHECKLIST_JS,
    mime: 'text/javascript; charset=utf-8'
  },
  '/__decky/widgets/matrix.js': { body: MATRIX_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/roadmap.js': { body: ROADMAP_JS, mime: 'text/javascript; charset=utf-8' },
  '/__decky/widgets/mermaid.js': { body: MERMAID_JS, mime: 'text/javascript; charset=utf-8' },
  // Local marked bundle — replaces the old https://esm.sh/marked@12 import. The empty body
  // case (MARKED_JS load failed) is intentional: serves an empty module that throws on use,
  // surfacing the failure in devtools instead of leaving the page silently stuck.
  [MARKED_URL]: { body: MARKED_JS, mime: 'text/javascript; charset=utf-8' }
}

export function getVirtualRoutes(): Record<string, { body: string; mime: string }> {
  return VIRTUAL_ROUTES
}

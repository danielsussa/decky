import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'
import MermaidBlock from './MermaidBlock'
import FlowBlock from './FlowBlock'
import ChecklistBlock from './ChecklistBlock'
import MatrixBlock from './MatrixBlock'
import RoadmapBlock from './RoadmapBlock'
import BacklinksFooter from './BacklinksFooter'
import remarkWikilinks from '../lib/remark-wikilinks'
import { splitIntoBlocks } from '../lib/markdown-blocks'
import { t } from '../lib/i18n'

// react-markdown's defaultUrlTransform whitelists protocols (http, https, mailto, …) and
// blanks anything else — so `wikilink:<name>` injected by remarkWikilinks would lose its
// href before our `a` override sees it. Allow the synthetic scheme through; defer to the
// default sanitizer for every other URL.
function wikilinkAwareUrlTransform(url: string): string {
  if (url.startsWith('wikilink:')) return url
  return defaultUrlTransform(url)
}

// Card paths live under `<workspace>/.decky/cards/...`. Strip the suffix to recover the
// workspace root — saves us threading a `workspace` prop through Preview/DeckGrid for
// wikilink resolution and backlinks lookups.
function workspaceFromCardPath(cardPath: string | undefined): string | undefined {
  if (!cardPath) return undefined
  const idx = cardPath.indexOf('/.decky/cards/')
  return idx > 0 ? cardPath.slice(0, idx) : undefined
}

// Compute the URL that "Copy URL" on a right-clicked image should write to the clipboard.
// Remote/data/file URLs pass through as-is. Relative srcs resolve to an absolute path on
// disk against the card's directory — that's what users actually need when pasting into a
// shell, a file dialog, or another markdown doc. We DON'T return the decky-asset:// form
// (it only works inside this app).
function copyableImageUrl(src: string | undefined, cardPath: string | undefined): string {
  if (!src) return ''
  if (/^(https?:|data:|file:|blob:)/i.test(src)) return src
  if (!cardPath) return src
  const lastSlash = cardPath.lastIndexOf('/')
  const baseDir = lastSlash >= 0 ? cardPath.slice(0, lastSlash) : ''
  const joined = src.startsWith('/') ? src : `${baseDir}/${src}`
  const parts = joined.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop()
    else if (part !== '.' && part !== '') acc.push(part)
    return acc
  }, [])
  return '/' + parts.join('/')
}

// Resolve <img src> against the .md file's directory. ReactMarkdown alone treats relative
// src as relative to the renderer page URL (http://localhost:xxxx in dev, file://app/... in
// prod), neither of which knows where the card .md lives. We rewrite relative srcs to the
// decky-asset:// protocol (see main/asset-protocol.ts) so they resolve to the actual file
// on disk — keeping the same relative path filesystem-native renderers (VSCode, GitHub)
// resolve, so the .md stays portable.
//
// We pass the workspace root as `?base=<encoded abs dir>` (falling back to the card's own
// directory when the card sits outside any `.decky/cards/` tree, e.g. a stray .md opened
// via preview_show). The protocol allows files under that base — so images in a workspace-
// level `imagens/` directory, not just under `.decky/cards/`, render correctly.
function resolveAssetSrc(
  src: string | undefined,
  cardPath: string | undefined
): string | undefined {
  if (!src) return src
  if (/^(https?:|data:|decky-asset:|blob:|file:)/i.test(src)) return src
  if (!cardPath) return src
  const lastSlash = cardPath.lastIndexOf('/')
  const baseDir = lastSlash >= 0 ? cardPath.slice(0, lastSlash) : ''
  const joined = src.startsWith('/') ? src : `${baseDir}/${src}`
  const parts = joined.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop()
    else if (part !== '.' && part !== '') acc.push(part)
    return acc
  }, [])
  // Authority 'card' is arbitrary but non-empty — Chromium silently drops <img>
  // requests for custom-scheme URLs with empty authority. Path segments are
  // encoded individually so slashes between them stay as path separators.
  const encoded = parts.map(encodeURIComponent).join('/')
  const allowBase = workspaceFromCardPath(cardPath) ?? baseDir
  const baseQ = allowBase ? `?base=${encodeURIComponent(allowBase)}` : ''
  return `decky-asset://card/${encoded}${baseQ}`
}

// Resolve a relative .md link to an absolute filesystem path against the card's directory.
// Returns undefined for absolute URLs, anchor-only hrefs, or when the card path is unknown.
function resolveMdLink(href: string | undefined, cardPath: string | undefined): string | undefined {
  if (!href) return undefined
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return undefined
  if (!cardPath) return undefined
  const noFrag = href.replace(/[#?].*$/, '')
  if (!/\.(md|markdown)$/i.test(noFrag)) return undefined
  const lastSlash = cardPath.lastIndexOf('/')
  const baseDir = lastSlash >= 0 ? cardPath.slice(0, lastSlash) : ''
  const joined = noFrag.startsWith('/') ? noFrag : `${baseDir}/${noFrag}`
  const parts = joined.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop()
    else if (part !== '.' && part !== '') acc.push(part)
    return acc
  }, [])
  return '/' + parts.join('/')
}

// Find every occurrence of `needle` inside text nodes under `container` and return one
// Range per match. Per-text-node search means matches that straddle inline markup
// (e.g. "foo **bar** baz") won't be found — the caller falls back to the user's original
// selection range in that case.
function findAllOccurrences(container: HTMLElement, needle: string): Range[] {
  if (!needle) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()
  while (node) {
    const text = node.nodeValue ?? ''
    let from = 0
    while (from <= text.length) {
      const idx = text.indexOf(needle, from)
      if (idx < 0) break
      const r = document.createRange()
      r.setStart(node, idx)
      r.setEnd(node, idx + needle.length)
      ranges.push(r)
      from = idx + needle.length
    }
    node = walker.nextNode()
  }
  return ranges
}

// rehype-highlight runs BEFORE this component override and wraps code content in nested
// <span> elements for syntax highlighting. By the time `code()` receives `children`, it's
// no longer the raw source — it's a React tree. `String(tree)` returns "[object Object]",
// which mermaid can't parse. Walk the tree and concatenate every text leaf to recover
// the original source.
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}

// Intercept fenced widget blocks. Other code blocks fall through to rehype-highlight.
// The img override rewrites relative <img src> against the card's path (see resolveAssetSrc).
// The a override turns relative .md links into card opens via decky:open-path (same channel
// the terminal's Cmd+click on a file ref uses).
function makeComponents(
  cardPath: string | undefined,
  cardId: string | undefined,
  sessionId: string | undefined,
  onImageContextMenu: (x: number, y: number, url: string) => void
): Components {
  return {
    code(props) {
      const { className, children, ...rest } = props
      const classes = className?.split(/\s+/) ?? []
      if (classes.includes('language-mermaid')) {
        return <MermaidBlock code={extractText(children).replace(/\n$/, '')} />
      }
      if (classes.includes('language-flow')) {
        return <FlowBlock code={extractText(children).replace(/\n$/, '')} cardId={cardId ?? ''} />
      }
      if (classes.includes('language-checklist')) {
        return (
          <ChecklistBlock code={extractText(children).replace(/\n$/, '')} cardId={cardId ?? ''} />
        )
      }
      if (classes.includes('language-matrix')) {
        return <MatrixBlock code={extractText(children).replace(/\n$/, '')} cardId={cardId ?? ''} />
      }
      if (classes.includes('language-roadmap')) {
        return (
          <RoadmapBlock code={extractText(children).replace(/\n$/, '')} cardId={cardId ?? ''} />
        )
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    },
    img(props) {
      const src = typeof props.src === 'string' ? props.src : undefined
      const resolved = resolveAssetSrc(src, cardPath)
      // Right-click on an image opens our own menu with "Copy URL". stopPropagation prevents
      // the parent .md-body onContextMenu (selection-based menu) from also firing.
      const onContextMenu = (ev: React.MouseEvent<HTMLImageElement>): void => {
        ev.preventDefault()
        ev.stopPropagation()
        onImageContextMenu(ev.clientX, ev.clientY, copyableImageUrl(src, cardPath))
      }
      return <img {...props} src={resolved} onContextMenu={onContextMenu} />
    },
    a(props) {
      const href = typeof props.href === 'string' ? props.href : undefined
      // Wikilink injected by remarkWikilinks: `wikilink:<name>`. Resolve via IPC to an
      // absolute card path, then route through the same decky:open-path channel as the
      // regular .md link override below.
      if (href && href.startsWith('wikilink:')) {
        const name = href.slice('wikilink:'.length)
        const workspace = workspaceFromCardPath(cardPath)
        const onClick = (ev: React.MouseEvent<HTMLAnchorElement>): void => {
          if (
            ev.defaultPrevented ||
            ev.button !== 0 ||
            ev.metaKey ||
            ev.ctrlKey ||
            ev.shiftKey ||
            ev.altKey
          )
            return
          ev.preventDefault()
          if (!workspace) return
          void window.deck.cards.resolveWikilink(workspace, name).then((target) => {
            if (!target) return
            window.dispatchEvent(
              new CustomEvent('decky:open-path', { detail: { path: target, sessionId } })
            )
          })
        }
        return (
          <a
            {...props}
            href="#"
            className="wikilink"
            title={`${t('md.openCardPrefix')}[[${name}]]`}
            onClick={onClick}
          />
        )
      }
      const target = resolveMdLink(href, cardPath)
      if (!target || !sessionId) return <a {...props} />
      const onClick = (ev: React.MouseEvent<HTMLAnchorElement>): void => {
        // Let modifier-clicks / middle-click fall through to default (which routes through
        // will-navigate → routeToInternal, fine for the rare "open in external" case).
        if (
          ev.defaultPrevented ||
          ev.button !== 0 ||
          ev.metaKey ||
          ev.ctrlKey ||
          ev.shiftKey ||
          ev.altKey
        )
          return
        ev.preventDefault()
        window.dispatchEvent(
          new CustomEvent('decky:open-path', { detail: { path: target, sessionId } })
        )
      }
      return <a {...props} onClick={onClick} />
    }
  }
}

interface MarkdownPreviewProps {
  content: string
  cardId?: string
  sessionId?: string
  path?: string
}

// Module-level so they survive component unmount/remount (tab switch).
//   - scrollByCard: restore per-card scroll position when remounting
//   - seenBlockKeys: a block key that has been rendered at least once skips its fade-in animation
//     on subsequent appearances (closing/reopening a card, re-render after sibling edit).
const scrollByCard = new Map<string, number>()
const seenBlockKeys = new Set<string>()

// Each top-level markdown block (heading, paragraph, list, fence, table, ...) renders inside
// its own keyed `<div className="md-block">`. The key is a hash of the block's source text:
// same content → same key → React preserves the same DOM → no animation. Different content
// at the same position (an edit) → new key → React mounts a fresh element → `.md-block-enter`
// fires the fade-in keyframes. Siblings stay untouched. Widgets (FlowBlock/ChecklistBlock)
// keep their internal state because the fence's source text is unchanged.
//
// memo()ed because App.tsx ticks a heartbeat state every ~600ms (collapsed-tab spinner). Without
// memo, this component re-renders unnecessarily and ReactMarkdown does pointless work, which
// would remount fence widgets (MermaidBlock re-runs mermaid.render, etc.).
function MarkdownPreviewInner({
  content,
  cardId,
  sessionId,
  path
}: MarkdownPreviewProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const blocks = useMemo(() => splitIntoBlocks(content), [content])

  // Right-click on selected text inside the .md-body opens a small floating menu.
  // For now the only action is "Expandir assunto": pre-create the sibling .md, open it as a
  // new card, highlight the selection here while the agent fills it in.
  // Right-click on an <img> opens the same menu shape with a "Copy URL" action — handled
  // through the img override's onImageContextMenu callback so the parent .md-body handler
  // (which needs a text selection) isn't involved.
  const [menu, setMenu] = useState<
    | { type: 'selection'; x: number; y: number; selection: string; range: Range }
    | { type: 'image'; x: number; y: number; url: string }
    | null
  >(null)

  const onImageContextMenu = (x: number, y: number, url: string): void => {
    setMenu({ type: 'image', x, y, url })
  }

  // Stable identity so ReactMarkdown doesn't see a "new" components prop on every render.
  const components = useMemo(
    () => makeComponents(path, cardId, sessionId, onImageContextMenu),
    [path, cardId, sessionId]
  )

  // Restore the saved scroll position when this card mounts/refocuses. Runs whenever the
  // block list changes — the card may grow over several renders, so we re-check until the
  // scrollable area has caught up to the saved offset.
  useEffect(() => {
    if (!cardId) return
    const el = bodyRef.current
    if (!el) return
    const saved = scrollByCard.get(cardId) ?? 0
    if (saved > 0 && Math.abs(el.scrollTop - saved) > 1 && el.scrollHeight >= saved) {
      el.scrollTop = saved
    }
  }, [cardId, blocks])

  const onScroll = (): void => {
    if (!cardId) return
    const el = bodyRef.current
    if (el) scrollByCard.set(cardId, el.scrollTop)
  }

  const onContextMenu = (ev: React.MouseEvent<HTMLDivElement>): void => {
    if (!sessionId || !path) return
    const winSel = window.getSelection()
    const sel = winSel?.toString().trim() ?? ''
    if (!sel || !winSel || winSel.rangeCount === 0) return
    ev.preventDefault()
    setMenu({
      type: 'selection',
      x: ev.clientX,
      y: ev.clientY,
      selection: sel,
      range: winSel.getRangeAt(0).cloneRange()
    })
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const expandSubject = async (selection: string, range: Range): Promise<void> => {
    if (!sessionId || !path) return
    setMenu(null)
    const lastSlash = path.lastIndexOf('/')
    const baseDir = lastSlash >= 0 ? path.slice(0, lastSlash) : ''
    const slugBase = selection
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    const slug = `${slugBase || 'expansao'}-${Math.random().toString(36).slice(2, 6)}`
    const relPath = `${slug}.md`
    const absPath = `${baseDir}/${relPath}`
    // Wikilink id is the new card's path relative to the workspace's cards root, sans `.md`.
    // Resolves via exact id match (avoids basename collisions across subfolders).
    const cardsRootIdx = absPath.indexOf('/.decky/cards/')
    const wikilinkId =
      cardsRootIdx >= 0
        ? absPath.slice(cardsRootIdx + '/.decky/cards/'.length, -'.md'.length)
        : slug

    // Highlight every occurrence of the selected text within this card. Walking text nodes
    // ourselves (instead of just adding the original range) means a selection like "carro"
    // that appears 3× in the card pulses in all 3 spots, and it also dodges a stale-range
    // bug where the captured Range sometimes ended up pointing at the last occurrence after
    // a memoized re-render. Fall back to the captured range if no per-text-node match
    // (e.g. selection spans bold/italic so the plain text only exists across nodes).
    const existing = CSS.highlights.get('expanding') as Highlight | undefined
    const hl = existing ?? new Highlight()
    if (!existing) CSS.highlights.set('expanding', hl)
    const ranges = bodyRef.current ? findAllOccurrences(bodyRef.current, selection) : []
    if (ranges.length === 0) ranges.push(range)
    for (const r of ranges) hl.add(r)
    document.body.classList.add('md-expanding-active')

    // Empty placeholder so the new card opens immediately (preview-server reads the file on POST).
    // The agent fills it with Write right after.
    try {
      await window.deck.file.write(absPath, '')
    } catch (err) {
      console.warn('[expand] placeholder write failed', err)
    }
    // focus: false → the new card opens as a background tab so the user stays on the
    // original (still pulsing) while the agent generates content. Focus is handed off
    // below once the agent's write fires file:changed with non-empty content.
    window.dispatchEvent(
      new CustomEvent('decky:open-path', { detail: { path: absPath, sessionId, focus: false } })
    )
    void window.deck.file.watch(absPath)
    const unsubscribe = window.deck.file.onChanged(({ path: changedPath }) => {
      if (changedPath !== absPath) return
      void window.deck.file.readText(absPath).then((text) => {
        if (text == null || text.trim().length === 0) return
        window.dispatchEvent(
          new CustomEvent('decky:focus-path', { detail: { path: absPath, sessionId } })
        )
        unsubscribe()
      })
    })

    const prompt =
      `Expandir o assunto destacado no card "${path}".\n` +
      `\n` +
      `Trecho selecionado (delimitado por <<< >>>):\n` +
      `<<<\n${selection}\n>>>\n` +
      `\n` +
      `Já preparei o arquivo de destino vazio em "${absPath}" e ele já está aberto como card novo. Faça:\n` +
      `1. Escreva o conteúdo do aprofundamento nesse arquivo com Write — escopo coerente com o card pai, sem repetir o que já está lá.\n` +
      `2. Edite o card original ("${path}") com Edit, substituindo EXATAMENTE o trecho selecionado por o wikilink: [[${wikilinkId}]]\n` +
      `   (O renderer transforma [[id]] em link lavanda clicável, e o card novo passa a aparecer como "Referenciado por" no rodapé deste — mantém o vínculo permanente).\n` +
      `3. NÃO chame preview_show — o card já está aberto.`
    // Bracketed paste so claude CLI ingests the multi-line prompt as one block instead of
    // submitting on every newline. The trailing \r after \e[201~ ends paste mode and submits.
    const wrapped = `\x1b[200~${prompt}\x1b[201~\r`
    window.deck.pty.write(sessionId, wrapped)
  }

  // Clear the "expanding" highlight when this card's content ACTUALLY changes (not on first
  // mount or tab-switch remount, which would wipe another card's in-flight highlight). The
  // content change is our signal that the agent just inserted the link.
  const prevContentRef = useRef(content)
  useEffect(() => {
    if (prevContentRef.current === content) return
    prevContentRef.current = content
    const hl = CSS.highlights.get('expanding') as Highlight | undefined
    if (hl && hl.size > 0) hl.clear()
    if (!hl || hl.size === 0) document.body.classList.remove('md-expanding-active')
  }, [content])

  return (
    <div className="md-preview">
      <div className="md-body" ref={bodyRef} onScroll={onScroll} onContextMenu={onContextMenu}>
        {blocks.map((block) => {
          const isNew = !seenBlockKeys.has(block.key)
          // Mark this key as seen synchronously so that an immediate re-render of the same
          // block (e.g. heartbeat tick) doesn't repeat the entry animation.
          seenBlockKeys.add(block.key)
          return (
            <div
              key={block.key}
              className={`md-block${isNew ? ' md-block-enter' : ''}`}
              data-block-type={block.type}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkWikilinks]}
                rehypePlugins={[rehypeRaw, rehypeHighlight]}
                urlTransform={wikilinkAwareUrlTransform}
                components={components}
              >
                {block.text}
              </ReactMarkdown>
            </div>
          )
        })}
        {path && sessionId && <BacklinksFooter cardPath={path} sessionId={sessionId} />}
      </div>
      {menu && (
        <div
          className="md-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.type === 'selection' ? (
            <button
              type="button"
              className="md-context-menu-item"
              onClick={() => void expandSubject(menu.selection, menu.range)}
            >
              Expandir assunto
            </button>
          ) : (
            <button
              type="button"
              className="md-context-menu-item"
              onClick={() => {
                if (menu.url) void navigator.clipboard.writeText(menu.url)
                setMenu(null)
              }}
            >
              {t('md.copyUrl')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const MarkdownPreview = memo(MarkdownPreviewInner)
export default MarkdownPreview

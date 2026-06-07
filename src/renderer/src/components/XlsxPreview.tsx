import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx-js-style'
import { t } from '../lib/i18n'

interface XlsxPreviewProps {
  path: string
}

type SheetCell = {
  text: string
  style: React.CSSProperties
  colSpan?: number
  rowSpan?: number
  hidden?: boolean
  href?: string
  align: 'left' | 'right' | 'center'
}

type SheetGrid = {
  name: string
  rows: SheetCell[][]
  colPx: number[]
  rowPx: (number | undefined)[]
}

// Excel "character width" → CSS pixels. The exact formula depends on the font; this is the
// canonical approximation (Calibri 11). Good enough for visual fidelity.
function colCharsToPx(wch: number): number {
  return Math.round(wch * 7 + 8)
}

// Excel column letter for index (0 → A, 25 → Z, 26 → AA).
function colLetter(c: number): string {
  let s = ''
  let n = c
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

// xlsx-js-style returns colors as {rgb:'RRGGBB'} | {rgb:'AARRGGBB'} | {theme,tint} | {indexed}.
// MVP: handle the direct rgb form (covers ~80% of real-world files). Theme/tint requires parsing
// the workbook theme and applying the OOXML tint formula — punt to a follow-up.
function colorToCss(c: unknown): string | undefined {
  if (!c || typeof c !== 'object') return undefined
  const cc = c as { rgb?: string }
  if (!cc.rgb || typeof cc.rgb !== 'string') return undefined
  const hex = cc.rgb.length === 8 ? cc.rgb.slice(2) : cc.rgb // strip alpha if ARGB
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined
  return '#' + hex.toUpperCase()
}

const BORDER_STYLE_MAP: Record<string, string> = {
  thin: '1px solid',
  hair: '1px dotted',
  dotted: '1px dotted',
  dashed: '1px dashed',
  medium: '2px solid',
  thick: '3px solid',
  double: '3px double',
  mediumDashed: '2px dashed',
  mediumDotted: '2px dotted',
  slantDashDot: '1px dashed'
}

function borderSide(side: unknown): string | undefined {
  if (!side || typeof side !== 'object') return undefined
  const s = side as { style?: string; color?: unknown }
  if (!s.style) return undefined
  const base = BORDER_STYLE_MAP[s.style] ?? '1px solid'
  const col = colorToCss(s.color) ?? '#999'
  return `${base} ${col}`
}

function alignToCss(t: string, h?: string): 'left' | 'right' | 'center' {
  if (h === 'left' || h === 'right' || h === 'center') return h
  // Excel default: numbers right, text/bool/date left or right (date is right).
  if (t === 'n' || t === 'd') return 'right'
  return 'left'
}

function buildGrid(ws: XLSX.WorkSheet, name: string): SheetGrid {
  const ref = ws['!ref']
  if (!ref) return { name, rows: [], colPx: [], rowPx: [] }
  const range = XLSX.utils.decode_range(ref)
  const nRows = range.e.r - range.s.r + 1
  const nCols = range.e.c - range.s.c + 1

  // Empty grid pre-filled with blank cells.
  const rows: SheetCell[][] = Array.from({ length: nRows }, () =>
    Array.from({ length: nCols }, () => ({ text: '', style: {}, align: 'left' as const }))
  )

  // First pass: stamp every cell with its content + style.
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr] as XLSX.CellObject | undefined
      const grid = rows[r - range.s.r][c - range.s.c]
      if (!cell) continue

      let text = ''
      if (cell.v != null) {
        if (cell.z && (cell.t === 'n' || cell.t === 'd')) {
          try {
            text = XLSX.SSF.format(cell.z as string, cell.v as number)
          } catch {
            text = String(cell.v)
          }
        } else if (cell.w != null) {
          text = String(cell.w)
        } else {
          text = String(cell.v)
        }
      }
      grid.text = text
      grid.align = alignToCss(cell.t ?? 's', (cell.s as { alignment?: { horizontal?: string } })?.alignment?.horizontal)

      const link = cell.l as { Target?: string } | undefined
      if (link?.Target) grid.href = link.Target

      const s = (cell.s ?? {}) as {
        font?: { bold?: boolean; italic?: boolean; sz?: number; color?: unknown; name?: string }
        fill?: { fgColor?: unknown; bgColor?: unknown; patternType?: string }
        alignment?: { vertical?: string; wrapText?: boolean }
        border?: { top?: unknown; bottom?: unknown; left?: unknown; right?: unknown }
      }

      const style: React.CSSProperties = {}
      if (s.font) {
        if (s.font.bold) style.fontWeight = 600
        if (s.font.italic) style.fontStyle = 'italic'
        if (s.font.sz) style.fontSize = `${s.font.sz}px`
        const fc = colorToCss(s.font.color)
        if (fc) style.color = fc
      }
      if (s.fill && s.fill.patternType !== 'none') {
        const bg = colorToCss(s.fill.fgColor) ?? colorToCss(s.fill.bgColor)
        if (bg) style.backgroundColor = bg
      }
      if (s.alignment?.vertical === 'center') style.verticalAlign = 'middle'
      else if (s.alignment?.vertical === 'top') style.verticalAlign = 'top'
      else style.verticalAlign = 'bottom'
      if (s.alignment?.wrapText) style.whiteSpace = 'pre-wrap'
      if (s.border) {
        const t = borderSide(s.border.top)
        const b = borderSide(s.border.bottom)
        const l = borderSide(s.border.left)
        const ri = borderSide(s.border.right)
        if (t) style.borderTop = t
        if (b) style.borderBottom = b
        if (l) style.borderLeft = l
        if (ri) style.borderRight = ri
      }
      grid.style = style
    }
  }

  // Second pass: apply merges. The top-left keeps its content + gets col/rowSpan; all other
  // cells in the range get hidden=true so render() skips them.
  const merges = (ws['!merges'] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[]
  for (const m of merges) {
    const r0 = m.s.r - range.s.r
    const c0 = m.s.c - range.s.c
    const r1 = m.e.r - range.s.r
    const c1 = m.e.c - range.s.c
    if (!rows[r0]?.[c0]) continue
    rows[r0][c0].colSpan = c1 - c0 + 1
    rows[r0][c0].rowSpan = r1 - r0 + 1
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r === r0 && c === c0) continue
        if (rows[r]?.[c]) rows[r][c].hidden = true
      }
    }
  }

  // Column widths. Excel stores wch (chars) or wpx (px). Missing entries get the default 64px.
  const colsMeta = (ws['!cols'] ?? []) as { wch?: number; wpx?: number; hidden?: boolean }[]
  const colPx: number[] = []
  for (let c = 0; c < nCols; c++) {
    const m = colsMeta[c + range.s.c]
    if (!m) colPx.push(80)
    else if (m.hidden) colPx.push(0)
    else if (m.wpx != null) colPx.push(Math.round(m.wpx))
    else if (m.wch != null) colPx.push(colCharsToPx(m.wch))
    else colPx.push(80)
  }

  // Row heights (optional).
  const rowsMeta = (ws['!rows'] ?? []) as { hpx?: number; hpt?: number; hidden?: boolean }[]
  const rowPx: (number | undefined)[] = []
  for (let r = 0; r < nRows; r++) {
    const m = rowsMeta[r + range.s.r]
    if (!m) rowPx.push(undefined)
    else if (m.hidden) rowPx.push(0)
    else if (m.hpx != null) rowPx.push(Math.round(m.hpx))
    else if (m.hpt != null) rowPx.push(Math.round(m.hpt * (96 / 72)))
    else rowPx.push(undefined)
  }

  return { name, rows, colPx, rowPx }
}

export default function XlsxPreview({ path }: XlsxPreviewProps): React.JSX.Element {
  const [sheets, setSheets] = useState<SheetGrid[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  // Read + parse. Re-runs on mount, on path change, and when reloadTick bumps from a
  // file:changed broadcast on this path.
  useEffect(() => {
    let cancelled = false
    if (reloadTick === 0) {
      setError(null)
      setSheets(null)
    }
    void window.deck.file
      .readBinary(path)
      .then((bytes) => {
        if (cancelled) return
        if (!bytes) {
          setError(t('xlsx.notFound'))
          return
        }
        try {
          const wb = XLSX.read(bytes, { type: 'array', cellStyles: true, cellDates: false })
          const grids = wb.SheetNames.map((n) => buildGrid(wb.Sheets[n] as XLSX.WorkSheet, n))
          if (cancelled) return
          setSheets(grids)
          setActive((prev) => (prev < grids.length ? prev : 0))
        } catch (err) {
          if (!cancelled) setError(`${t('xlsx.parseFailPrefix')}${(err as Error).message}`)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(`${t('xlsx.readFailPrefix')}${err.message}`)
      })
    return () => {
      cancelled = true
    }
  }, [path, reloadTick])

  // Disk change → bump reloadTick to re-fire the parse effect above.
  // App.tsx adds xlsx paths to the global watched set, so file:changed fires on save.
  useEffect(() => {
    return window.deck.file.onChanged(({ path: changed }) => {
      if (changed === path) setReloadTick((n) => n + 1)
    })
  }, [path])

  const current = useMemo(() => (sheets ? sheets[active] : null), [sheets, active])

  if (error) {
    return (
      <div className="xlsx-preview xlsx-error">
        <p>{error}</p>
        <p className="xlsx-path">{path}</p>
      </div>
    )
  }
  if (!sheets) {
    return (
      <div className="xlsx-preview xlsx-loading">
        <p>carregando planilha…</p>
      </div>
    )
  }
  if (!current) {
    return (
      <div className="xlsx-preview xlsx-error">
        <p>planilha vazia</p>
      </div>
    )
  }

  return (
    <div className="xlsx-preview">
      <div className="xlsx-grid-wrap">
        <table className="xlsx-grid" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <colgroup>
            <col style={{ width: 40 }} />
            {current.colPx.map((px, i) => (
              <col key={i} style={{ width: px === 0 ? 0 : px }} />
            ))}
          </colgroup>
          <thead>
            <tr className="xlsx-head-row">
              <th className="xlsx-corner" />
              {current.colPx.map((px, i) => (
                <th key={i} className="xlsx-col-head" style={{ display: px === 0 ? 'none' : undefined }}>
                  {colLetter(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {current.rows.map((row, r) => {
              const rpx = current.rowPx[r]
              if (rpx === 0) return null
              return (
                <tr key={r} style={rpx != null ? { height: rpx } : undefined}>
                  <th className="xlsx-row-head">{r + 1}</th>
                  {row.map((cell, c) => {
                    if (cell.hidden) return null
                    const cellStyle: React.CSSProperties = {
                      ...cell.style,
                      textAlign: cell.align
                    }
                    const content = cell.href ? (
                      <a
                        href={cell.href}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          // Let the OS open it; prevent navigation inside the renderer.
                          e.preventDefault()
                          window.open(cell.href, '_blank')
                        }}
                      >
                        {cell.text}
                      </a>
                    ) : (
                      cell.text
                    )
                    return (
                      <td
                        key={c}
                        className="xlsx-cell"
                        style={cellStyle}
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                      >
                        {content}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {sheets.length > 1 && (
        <div className="xlsx-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              className={i === active ? 'xlsx-tab xlsx-tab-active' : 'xlsx-tab'}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

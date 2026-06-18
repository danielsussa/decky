// Auto-focus is a convenience for a freshly-shown preview — never a license to yank the caret
// out from under the user mid-keystroke. A preview that mounts/reloads on the side (e.g. a form
// or editor card appearing while the user types a prompt in the terminal) must NOT steal focus
// if the user is already typing somewhere editable. The terminal is an xterm hidden textarea
// (.xterm-helper-textarea), so an INPUT/TEXTAREA/contenteditable check covers it plus any other
// real input. The WebContentsView live-reload path has its own focus guard in main/web-views.ts.
export function userIsTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

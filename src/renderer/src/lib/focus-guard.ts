// Auto-focus is a convenience for a freshly-shown preview — never a license to yank the caret
// out from under the user mid-keystroke. A preview that mounts/reloads on the side (e.g. a form
// or editor card appearing while the user types a prompt in the terminal) must NOT steal focus
// if the user is already typing somewhere editable. The terminal is an xterm hidden textarea
// (.xterm-helper-textarea), so an INPUT/TEXTAREA/contenteditable check covers it plus any other
// real input. The WebContentsView live-reload path has its own focus guard in main/web-views.ts.
export function userIsTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  return isEditable(el)
}

function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

let guardInstalled = false
// Rede final contra "o foco vai embora do nada": enquanto um elemento editável (input/textarea/
// contenteditable — inclui o <textarea> escondido do xterm) está focado, NENHUM `.focus()`
// PROGRAMÁTICO pode mover o foco pra um elemento NÃO editável. Cobre de uma vez todos os pontos do
// renderer (previews, tree, widgets, libs) sem precisar caçar cada chamada. É seguro: foco nativo
// (clique, Tab) NÃO passa por HTMLElement.prototype.focus, então cliques do usuário seguem normais;
// e foco editável→editável (trocar de input, focar o terminal) continua liberado. O par no main
// (web-views.wireEvents 'focus') cobre o roubo de foco de OS por WebContentsView/sites.
export function installEditableFocusGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  const proto = HTMLElement.prototype
  const nativeFocus = proto.focus
  proto.focus = function (this: HTMLElement, options?: FocusOptions): void {
    const active = document.activeElement as HTMLElement | null
    // Bloqueia só quando: já há um editável focado, conectado ao DOM, diferente do alvo, e o alvo
    // NÃO é editável. Qualquer outro caso (inclusive focar um editável) passa direto.
    if (
      active &&
      active !== this &&
      active.isConnected &&
      isEditable(active) &&
      !isEditable(this)
    ) {
      return
    }
    return nativeFocus.call(this, options)
  }
}

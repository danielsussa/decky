import type { Locale } from '@decky/shared'

// Tiny string dictionary, no runtime deps. Keys are flat dotted ids; values are
// language → string. For inline-interpolated messages we split into prefix/suffix
// chunks instead of carrying a templater — keeps the helper a one-liner.
const messages = {
  // common — reusable labels for buttons / states. Prefer area-specific keys
  // when the wording differs; keep these for the genuinely shared cases.
  'common.close': { pt: 'fechar', en: 'close' },
  'common.cancel': { pt: 'cancelar', en: 'cancel' },
  'common.save': { pt: 'salvar', en: 'save' },
  'common.open': { pt: 'Abrir', en: 'Open' },
  'common.confirm': { pt: 'Confirmar', en: 'Confirm' },
  'common.delete': { pt: 'Deletar', en: 'Delete' },
  'common.error': { pt: 'erro', en: 'error' },
  'common.reload': { pt: 'Recarregar', en: 'Reload' },

  // dev rebuild button
  'rebuild.running': { pt: 'Rebuilding…', en: 'Rebuilding…' },
  'rebuild.readyPrefix': { pt: '↻ Build pronto em ', en: '↻ Build ready in ' },
  'rebuild.readySuffix': { pt: ' — clique pra relaunch', en: ' — click to relaunch' },
  'rebuild.errorPrefix': { pt: 'Rebuild falhou em ', en: 'Rebuild failed in ' },
  'rebuild.errorSuffix': { pt: ' — clique pra tentar de novo', en: ' — click to retry' },
  'rebuild.readyTooltip': { pt: 'Clique pra relaunch', en: 'Click to relaunch' },
  'rebuild.errorTooltip': { pt: 'Clique pra tentar de novo', en: 'Click to retry' },

  // web preview (browser card)
  'web.back': { pt: 'voltar', en: 'back' },
  'web.forward': { pt: 'avançar', en: 'forward' },
  'web.reload': { pt: 'recarregar', en: 'reload' },
  'web.urlPlaceholder': { pt: 'digite uma URL e Enter…', en: 'enter a URL and press Enter…' },
  'web.openExternal': { pt: 'abrir no navegador externo', en: 'open in external browser' },
  'web.devtools': { pt: 'inspecionar (DevTools)', en: 'inspect (DevTools)' },

  // git stats — wrap the interpolated +A −D count
  'git.openDiffSuffix': { pt: ' — abrir diff', en: ' — open diff' },
  'git.notCommittedSuffix': { pt: ' (não commitado)', en: ' (uncommitted)' },

  // terminal host
  'term.notInstalledSuffix': {
    pt: ' não está instalado nesta máquina.',
    en: ' is not installed on this machine.'
  },
  'term.resolvingPrefix': { pt: 'resolvendo ', en: 'resolving ' },
  'term.noSessions': {
    pt: 'nenhuma sessão — abra uma no workspace acima',
    en: 'no sessions — open one in the workspace above'
  },

  // shortcuts panel
  'shortcuts.heading': { pt: 'Atalhos de teclado', en: 'Keyboard shortcuts' },
  'shortcuts.useModifier': {
    pt: 'use ao menos um modificador (Cmd / Ctrl / Alt)',
    en: 'use at least one modifier (Cmd / Ctrl / Alt)'
  },
  'shortcuts.alreadyAssignedPrefix': { pt: ' já está em "', en: ' is already assigned to "' },
  'shortcuts.alreadyAssignedSuffix': { pt: '"', en: '"' },
  'shortcuts.recording': { pt: 'pressione…', en: 'press…' },
  'shortcuts.tooltip': {
    pt: 'clique e pressione o novo atalho',
    en: 'click and press the new shortcut'
  },
  'shortcuts.reset': { pt: 'restaurar padrão', en: 'restore default' },
  'shortcuts.hint': {
    pt: 'clique num atalho e pressione a nova combinação · Esc cancela',
    en: 'click a shortcut and press the new combo · Esc cancels'
  },

  // editor card
  'editor.saveFailed': { pt: 'falha ao salvar', en: 'save failed' },
  'editor.diskChanged': {
    pt: 'disco mudou — descartar e recarregar',
    en: 'disk changed — discard and reload'
  },
  'editor.dirty': { pt: '● não salvo', en: '● unsaved' },
  'editor.saved': { pt: 'salvo', en: 'saved' },
  'editor.saveSuffix': { pt: ' salvar', en: ' save' },

  // form preview
  'form.untitled': { pt: 'Formulário', en: 'Form' },
  'form.sent': { pt: '✓ enviado', en: '✓ sent' },
  'form.cancelled': { pt: 'cancelado', en: 'cancelled' },
  'form.sending': { pt: 'enviando…', en: 'sending…' },
  'form.sendFailed': { pt: 'falha ao enviar', en: 'send failed' },
  'form.selectPlaceholder': { pt: '— selecione —', en: '— select —' },

  // workspace tree
  'ws.closeWorkspace': { pt: 'fechar workspace', en: 'close workspace' },
  'ws.closeSession': { pt: 'fechar sessão', en: 'close session' },
  'ws.newSession': { pt: 'nova sessão', en: 'new session' },
  'ws.saveForLater': { pt: 'salvar pra depois', en: 'save for later' },
  'ws.closeForReal': { pt: 'fechar mesmo', en: 'close anyway' },
  'ws.stashSection': { pt: 'Mais tarde', en: 'Stash' },
  'ws.stashEmpty': { pt: 'nada salvo aqui', en: 'nothing saved here' },
  'ws.stashCardCount': { pt: 'cards', en: 'cards' },
  'ws.stashDiscard': { pt: 'descartar', en: 'discard' },
  'ws.stashChipOne': { pt: 'stash', en: 'stash' },
  'ws.stashChipMany': { pt: 'stashes', en: 'stashes' },
  'ws.stashRestoreHint': {
    pt: 'click: reviver · shift: nova sessão · cmd: manter no stash',
    en: 'click: revive · shift: new session · cmd: keep in stash'
  },

  // diff preview
  'diff.empty': { pt: 'sem mudanças no diff', en: 'no changes in diff' },

  // me preview (handoff daemon status)
  'me.daemonDownPrefix': { pt: 'o ', en: 'the ' },
  'me.daemonDownMiddle': {
    pt: ' não está rodando (sem servidor em ',
    en: ' is not running (no server at '
  },
  'me.daemonDownSuffix': { pt: ').', en: ').' },
  'me.daemonHowToPrefix': { pt: 'rode ', en: 'run ' },
  'me.daemonHowToSuffix': {
    pt: ' num terminal e clique recarregar.',
    en: ' in a terminal and click reload.'
  },
  'me.reload': { pt: 'recarregar', en: 'reload' },

  // deck tabs
  'tabs.pinHint': {
    pt: 'duplo-clique pra fixar/desafixar · arraste pra reordenar',
    en: 'double-click to pin/unpin · drag to reorder'
  },
  'tabs.closeCard': { pt: 'fechar card', en: 'close card' },

  // pages panel
  'pages.filterPlaceholder': { pt: 'filtrar páginas…', en: 'filter pages…' },
  'pages.loading': { pt: 'carregando…', en: 'loading…' },
  'pages.empty': { pt: 'Nenhuma página neste workspace.', en: 'No pages in this workspace.' },
  'pages.emptyFilter': { pt: 'Nada bate com o filtro.', en: 'No matches for the filter.' },

  // deck grid card chrome
  'grid.unpin': { pt: 'desafixar', en: 'unpin' },
  'grid.pinAll': { pt: 'fixar em todas as sessões', en: 'pin in all sessions' },
  'grid.unfocus': { pt: 'desselecionar', en: 'unfocus' },
  'grid.focus': { pt: 'selecionar card', en: 'focus card' },
  'grid.exitFullscreen': { pt: 'sair do fullscreen', en: 'exit fullscreen' },
  'grid.fullscreen': { pt: 'expandir card', en: 'expand card' },

  // first-run / CLI settings modal
  'cli.pathPlaceholder': {
    pt: '/caminho/do/binario-ou-wrapper.sh',
    en: '/path/to/binary-or-wrapper.sh'
  },
  'cli.pickFile': { pt: 'Escolher arquivo', en: 'Choose file' },
  'cli.validating': { pt: 'validando…', en: 'validating…' },
  'cli.clearOverride': { pt: 'limpar override', en: 'clear override' },
  'cli.notDetected': { pt: 'não detectado', en: 'not detected' },
  'cli.editPath': { pt: 'caminho…', en: 'path…' },
  'cli.edit': { pt: 'editar', en: 'edit' },
  'cli.invalid': { pt: 'inválido', en: 'invalid' },
  'cli.okPrefix': { pt: 'ok — ', en: 'ok — ' },
  'cli.ok': { pt: 'ok', en: 'ok' },
  'cli.headingNoCli': { pt: 'Nenhum CLI de IA encontrado', en: 'No AI CLI found' },
  'cli.headingChoose': { pt: 'Escolha seu CLI de IA padrão', en: 'Choose your default AI CLI' },
  'cli.headingSettings': { pt: 'CLIs de IA', en: 'AI CLIs' },
  'cli.subEmpty': {
    pt: 'Instale um destes ou aponte um caminho customizado (ex.: script wrapper). Você pode pular e configurar depois.',
    en: 'Install one of these or point to a custom path (e.g. wrapper script). You can skip and set up later.'
  },
  'cli.subPick': {
    pt: 'Esse será o CLI usado em sessões novas. Você pode trocar o caminho — útil se usa um wrapper script.',
    en: 'This will be the CLI used in new sessions. You can change the path — useful if you use a wrapper script.'
  },
  'cli.skip': { pt: 'pular', en: 'skip' },
  'cli.recheck': { pt: 'já instalei, verificar', en: 'I installed it, check again' },
  'cli.rechecking': { pt: 'verificando…', en: 'checking…' },
  'cli.useDefault': { pt: 'usar como padrão', en: 'use as default' },
  'cli.pickFileDialog': {
    pt: 'Selecione o binário ou wrapper script',
    en: 'Select the binary or wrapper script'
  },

  // card search palette
  'search.placeholder': { pt: 'buscar nos cards…', en: 'search cards…' },
  'search.noCards': { pt: 'nenhum card', en: 'no cards' },
  'search.emptyWorkspace': { pt: 'nenhum card neste workspace', en: 'no cards in this workspace' },

  // xlsx preview
  'xlsx.notFound': {
    pt: 'arquivo não encontrado ou ilegível',
    en: 'file not found or unreadable'
  },
  'xlsx.parseFailPrefix': { pt: 'falha ao parsear xlsx: ', en: 'failed to parse xlsx: ' },
  'xlsx.readFailPrefix': { pt: 'falha ao ler arquivo: ', en: 'failed to read file: ' },

  // markdown wikilinks
  'md.openCardPrefix': { pt: 'abrir card ', en: 'open card ' },
  'md.copyUrl': { pt: 'Copiar URL', en: 'Copy URL' },

  // command palette
  'palette.placeholder': { pt: 'digite um comando…', en: 'type a command…' },

  // workspace side panels & palette commands
  'panel.shortcuts': { pt: 'Atalhos', en: 'Shortcuts' },
  'panel.shortcuts.paletteLabel': { pt: 'Atalhos de teclado', en: 'Keyboard shortcuts' },
  'panel.pages': { pt: 'Páginas', en: 'Pages' },
  'panel.pages.paletteLabel': { pt: 'Páginas do workspace', en: 'Workspace pages' },
  'cmd.themeLight': { pt: 'Tema claro', en: 'Light theme' },
  'cmd.themeDark': { pt: 'Tema escuro', en: 'Dark theme' },
  'cmd.appearance': { pt: 'aparência', en: 'appearance' },
  'cmd.colorPrefix': { pt: 'Cor: ', en: 'Color: ' },
  'cmd.workspaceTheme': { pt: 'tema do workspace', en: 'workspace theme' },
  'cmd.newWebTab': { pt: 'Nova aba de browser', en: 'New browser tab' },
  'cmd.webTabHint': { pt: 'abre um webview', en: 'opens a webview' },
  'cmd.googleSearch': { pt: 'Buscar no Google', en: 'Search Google' },
  'cmd.googleSearchHint': {
    pt: 'abre nova aba com a busca',
    en: 'opens a new tab with the search'
  },
  'cmd.googleSearchPrompt': {
    pt: 'digite a busca depois de //',
    en: 'type your query after //'
  },
  'cmd.testNotification': { pt: 'Testar notificação', en: 'Test notification' },
  'cmd.diagnostic': { pt: 'diagnóstico', en: 'diagnostic' },
  'cmd.notificationTestBody': { pt: 'teste de notificação', en: 'notification test' },
  'cmd.panelHint': { pt: 'painel', en: 'panel' }
} as const satisfies Record<string, Record<Locale, string>>

export type MessageKey = keyof typeof messages

const locale: Locale = window.deck?.app?.locale ?? 'en'

export function t(key: MessageKey): string {
  return messages[key][locale]
}

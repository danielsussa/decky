import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// All web cards share this partition (persist:deckweb). Cookies, storage, and the handlers
// configured here are scoped to it — distinct from the app shell's own session so a bad cert
// or runaway permission on the webview can't leak into decky itself.
export const WEB_PARTITION = 'persist:deckweb'

// Chrome's UA shape; we fill the Chromium major from process.versions.chrome at runtime so the
// string matches the actual engine version each Electron upgrade brings.
function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '134.0.0.0'
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

function chromeMajor(): string {
  return (process.versions.chrome || '134.0.0.0').split('.')[0]
}

// Real Chrome's Sec-CH-UA includes a "Google Chrome" brand; Electron's default omits it (sends
// only "Chromium" + a randomized "Not.A/Brand" filler), which Google's login flow specifically
// gates on. We also pre-send the high-entropy hints (Full-Version-List, Arch, Platform-Version,
// Bitness) that accounts.google.com requests via Accept-CH on the 2nd round-trip — a real
// Chrome would auto-reply with them; absence is itself a signal of non-Chrome.
function clientHintsHeaders(): Record<string, string> {
  const v = chromeMajor()
  const full = process.versions.chrome || `${v}.0.0.0`
  const platform =
    process.platform === 'darwin'
      ? '"macOS"'
      : process.platform === 'win32'
        ? '"Windows"'
        : '"Linux"'
  // Arch values Chrome reports: arm on Apple Silicon, x86 elsewhere.
  const arch = process.arch === 'arm64' || process.arch === 'arm' ? '"arm"' : '"x86"'
  const bitness = process.arch.includes('64') ? '"64"' : '"32"'
  // Platform version — Chrome reports the OS version. macOS: 14.5.0 fits as a recent default;
  // close enough for fingerprint matching since we can't always introspect the real one cheaply.
  const platformVersion =
    process.platform === 'darwin' ? '"14.5.0"' : process.platform === 'win32' ? '"15.0.0"' : '"6.5.0"'
  return {
    'Sec-CH-UA': `"Chromium";v="${v}", "Not:A-Brand";v="24", "Google Chrome";v="${v}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platform,
    'Sec-CH-UA-Platform-Version': platformVersion,
    'Sec-CH-UA-Arch': arch,
    'Sec-CH-UA-Bitness': bitness,
    'Sec-CH-UA-Model': '""',
    'Sec-CH-UA-Wow64': '?0',
    'Sec-CH-UA-Full-Version-List': `"Chromium";v="${full}", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="${full}"`,
    'Sec-CH-UA-Full-Version': `"${full}"`
  }
}

// Mirrors Chrome's "ask the first time per origin, remember the answer for the session" model.
// In-memory only for now — clearing the app forgets the grants, same as Chrome's incognito.
type PermissionDecision = 'allow' | 'deny'
const permissionMemo = new Map<string, PermissionDecision>()

// Translate the cryptic Chromium permission names into something a human would actually read in a
// dialog. Anything not listed falls back to the raw key.
const PERMISSION_LABELS: Record<string, string> = {
  notifications: 'enviar notificações',
  geolocation: 'acessar sua localização',
  media: 'acessar câmera e/ou microfone',
  midi: 'acessar dispositivos MIDI',
  midiSysex: 'enviar mensagens MIDI SysEx',
  'clipboard-read': 'ler o conteúdo da sua área de transferência',
  'clipboard-sanitized-write': 'escrever na sua área de transferência',
  'display-capture': 'capturar sua tela',
  'persistent-storage': 'armazenar dados persistentemente',
  pointerLock: 'travar o cursor do mouse',
  fullscreen: 'entrar em tela cheia',
  openExternal: 'abrir um aplicativo externo',
  hid: 'acessar dispositivos HID',
  serial: 'acessar dispositivos seriais',
  usb: 'acessar dispositivos USB',
  'window-management': 'gerenciar suas janelas'
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

// Popup classifier: window.open with explicit size/position features → real popup window
// (Chrome opens a chrome-less window). Anything else (target=_blank, window.open(url) without
// features) → "tab", which in decky's world means a new web card in the active session.
function looksLikePopupWindow(features: string): boolean {
  if (!features) return false
  return /\b(?:width|height|popup|left|top|screenx|screeny)\s*=/i.test(features)
}

// resources/webview-preload.js needs to load as a real file at runtime: in dev that's the
// repo's resources/, in a packaged build it's the asar.unpacked mirror (asarUnpack:
// resources/** in electron-builder.yml). Same trick used for dky-mcp resolution.
function resolveWebviewPreload(): string | null {
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
  const p = join(base, 'resources', 'webview-preload.js')
  return existsSync(p) ? p : null
}

export function setupWebSession(getMainWindow: () => BrowserWindow | null): void {
  const ses = session.fromPartition(WEB_PARTITION)

  // Inject the stealth preload into every guest page in this partition BEFORE its scripts
  // run — only path to spoof navigator.userAgentData (a JS API, not a header) so Google's
  // account login check sees a "Google Chrome" brand instead of bare Chromium.
  const preloadPath = resolveWebviewPreload()
  if (preloadPath) {
    ses.setPreloads([preloadPath])
  } else {
    console.warn('[web-session] webview-preload.js not found — stealth JS spoofs disabled')
  }

  // 1. User-Agent — strip Electron/decky tokens, present as plain Chrome. Captcha vendors
  //    (hCaptcha, reCAPTCHA, Cloudflare Turnstile) gate on UA; Electron strings get challenge
  //    pages or outright blocks. The 2nd arg sets Accept-Language to the host locale.
  const ua = chromeUserAgent()
  const lang = app.getLocale() || 'en-US'
  ses.setUserAgent(ua, lang)

  // Some endpoints sniff per-request headers in addition to the UA. Enforce UA, Accept-Language,
  // and the Sec-CH-UA client hints together — Google's account login specifically gates on the
  // "Google Chrome" brand inside Sec-CH-UA, so a clean UA alone isn't enough.
  const hints = clientHintsHeaders()
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['User-Agent'] = ua
    details.requestHeaders['Accept-Language'] = `${lang},${lang.split('-')[0]};q=0.9,en;q=0.8`
    // Only set hints on secure contexts — browsers don't send Sec-CH-* over plain http,
    // mirroring that avoids accidentally outing us as non-standard on http endpoints.
    if (details.url.startsWith('https://')) {
      for (const [k, v] of Object.entries(hints)) details.requestHeaders[k] = v
    }
    cb({ requestHeaders: details.requestHeaders })
  })

  // 2. Permissions — same UX as Chrome: ask the user the first time an origin requests a given
  //    permission, then remember the answer for the rest of the session. No silent allow.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originOf(details?.requestingUrl || webContents.getURL())
    const key = `${origin}::${permission}`
    const memo = permissionMemo.get(key)
    if (memo) {
      callback(memo === 'allow')
      return
    }
    const label = PERMISSION_LABELS[permission] ?? `usar "${permission}"`
    const parent = getMainWindow() ?? undefined
    void dialog
      .showMessageBox(parent!, {
        type: 'question',
        buttons: ['Permitir', 'Bloquear'],
        defaultId: 0,
        cancelId: 1,
        title: 'Permissão do site',
        message: `${origin} quer ${label}.`,
        detail: 'Sua escolha vale enquanto a decky estiver aberta.'
      })
      .then((res) => {
        const decision: PermissionDecision = res.response === 0 ? 'allow' : 'deny'
        permissionMemo.set(key, decision)
        callback(decision === 'allow')
      })
      .catch(() => callback(false))
  })
  // Some APIs (Notification API, Clipboard query) call the synchronous check path. Allow what
  // we've already granted, deny everything else by default — the request handler above is the
  // only place a previously-unknown permission can be approved.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const key = `${requestingOrigin}::${permission}`
    return permissionMemo.get(key) === 'allow'
  })

  // 3. Downloads — Chrome's default is "save to ~/Downloads, no prompt". Match that. We hold a
  //    reference to the item so its event listeners stay alive until completion.
  ses.on('will-download', (_event, item) => {
    const target = join(app.getPath('downloads') || join(homedir(), 'Downloads'), item.getFilename())
    item.setSavePath(target)
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        // Reveal in Finder on success — mirrors Chrome's download shelf "show in folder" without
        // requiring the user to dig through Finder themselves.
        try {
          shell.showItemInFolder(target)
        } catch {
          // best-effort
        }
      }
    })
  })

  return undefined
}

// Webview popups need wiring in main: setWindowOpenHandler must be installed on the GUEST
// webContents (not the host page), so it has to happen via app.on('web-contents-created').
// We treat real popup windows (window.open with size features) as native BrowserWindows on
// the same partition (so cookies/login carry over and `opener` is preserved for OAuth /
// 3-D Secure flows); everything else (target=_blank, plain window.open) is forwarded to
// the renderer as a new web card via the existing 'app:open-url' channel.
export function attachWebContentsPopupRouter(getMainWindow: () => BrowserWindow | null): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler((details) => {
      const popup = looksLikePopupWindow(details.features || '')
      if (!popup) {
        // Tab-like: route to a new decky web card.
        getMainWindow()?.webContents.send('app:open-url', details.url)
        return { action: 'deny' }
      }
      // Real popup: allow Electron to spawn a BrowserWindow, but force same partition so
      // session/cookies carry over, and keep the native window chrome minimal (no menu bar).
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            partition: WEB_PARTITION,
            sandbox: true,
            contextIsolation: true
          }
        }
      }
    })
  })
}

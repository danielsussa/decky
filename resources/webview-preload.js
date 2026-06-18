// Stealth preload for the deckweb partition. Loaded via session.setPreloads in main, so it
// runs inside every web card's guest page BEFORE any page script executes — the only window
// where we can redefine globals like navigator.userAgentData that Google's account login
// checks. Pure DOM JS: no Electron / Node APIs (the guest is sandboxed; importing them throws).

// navigator.userAgentData spoof, as a SELF-CONTAINED function so it can run both here (main
// thread) AND be stringified for injection into Web Workers — workers have their own
// WorkerNavigator whose userAgentData is the raw Chromium one, and CreepJS-class detectors spawn a
// worker to catch exactly that main/worker mismatch. Targets Object.getPrototypeOf(navigator) so
// the same code patches Navigator.prototype (window) or WorkerNavigator.prototype (worker).
function spoofUserAgentData() {
  try {
    const ua = navigator.userAgent || ''
    const m = /Chrome\/(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(ua)
    const major = m ? m[1] : '134'
    const fullVersion = m && m[2] ? major + '.' + m[2] : major + '.0.0.0'
    const platform = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux'
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Not:A-Brand', version: '24' },
      { brand: 'Google Chrome', version: major }
    ]
    // GREASE brand keeps its own version in the full list (matches the Sec-CH-UA header); the real
    // brands carry the full Chrome version. Mismatching this against the header is itself a tell.
    const fullBrands = brands.map(function (b) {
      return { brand: b.brand, version: b.brand === 'Not:A-Brand' ? '24.0.0.0' : fullVersion }
    })
    const fakeUAD = {
      brands: brands,
      mobile: false,
      platform: platform,
      getHighEntropyValues: function (hints) {
        const out = { brands: brands, mobile: false, platform: platform }
        if (Array.isArray(hints)) {
          if (hints.includes('platformVersion')) out.platformVersion = '14.5.0'
          if (hints.includes('architecture')) out.architecture = 'arm'
          if (hints.includes('model')) out.model = ''
          if (hints.includes('uaFullVersion')) out.uaFullVersion = fullVersion
          if (hints.includes('bitness')) out.bitness = '64'
          if (hints.includes('fullVersionList')) out.fullVersionList = fullBrands
          if (hints.includes('wow64')) out.wow64 = false
        }
        return Promise.resolve(out)
      },
      toJSON: function () {
        return { brands: brands, mobile: false, platform: platform }
      }
    }
    Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgentData', {
      get: function () {
        return fakeUAD
      },
      configurable: true
    })
  } catch (err) {
    // read-only on some engines / scopes
  }
}

;(() => {
  // navigator.webdriver — DELIBERATELY left untouched. In a top-level WebContentsView (no
  // --enable-automation) the native value is already `false`; overriding it with a defineProperty
  // getter is not only redundant but counterproductive — CreepJS-class detectors notice the
  // property is a non-native lie and conclude `webDriverIsOn: true`. Letting the native false
  // stand is the better disguise. (The old <webview> set disableblinkfeatures="AutomationControlled";
  // WebContentsView cards no longer carry that attribute, and don't need it.)

  // navigator.userAgentData — the JS-side equivalent of Sec-CH-UA. Header spoof alone leaves this
  // returning "Chromium" + a Not:A-Brand filler, which Google's login inspects via
  // getHighEntropyValues() and refuses. Mirror a stock Chrome on this platform.
  spoofUserAgentData()

  // Web Workers run their own global scope with a fresh WorkerNavigator — the main-thread patch
  // doesn't reach it, so a detector that reads userAgentData inside a worker sees bare Chromium and
  // flags the mismatch. Wrap the Worker / SharedWorker constructors to prepend the same spoof to
  // the worker before its real script runs, via a blob that importScripts() the original URL.
  // Conservative: skip module workers (no importScripts), and fall back to the native constructor
  // on any failure (CSP blocking blob: workers, cross-scheme) so real sites never break.
  try {
    const patchSrc = '(' + spoofUserAgentData.toString() + ')();\n'
    const wrap = (Native) => {
      const Wrapped = function (url, options) {
        try {
          if (!options || options.type !== 'module') {
            const abs = new URL(url, self.location.href).href
            const src = patchSrc + 'importScripts(' + JSON.stringify(abs) + ');'
            const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
            return new Native(blobUrl, options)
          }
        } catch (err) {
          // fall through to the unwrapped worker
        }
        return new Native(url, options)
      }
      Wrapped.prototype = Native.prototype
      try {
        Object.defineProperty(Wrapped, 'name', { value: Native.name })
        Wrapped.toString = () => Native.toString()
      } catch {
        // best-effort masking
      }
      return Wrapped
    }
    if (typeof self.Worker === 'function') self.Worker = wrap(self.Worker)
    if (typeof self.SharedWorker === 'function') self.SharedWorker = wrap(self.SharedWorker)
  } catch (err) {
    console.warn('[decky webview preload] worker stealth install failed', err)
  }

  // Notification.permission — headless / some embedded configs default this to 'denied', whereas a
  // fresh real Chrome reports 'default' (undecided, will prompt on request). Detectors weight the
  // 'denied' default as a headless tell. Map only the 'denied' default back to 'default'; a real
  // 'granted'/'denied' the user actually chose is preserved.
  try {
    if (typeof Notification === 'function') {
      const d = Object.getOwnPropertyDescriptor(Notification, 'permission')
      if (d && d.get) {
        Object.defineProperty(Notification, 'permission', {
          configurable: true,
          get() {
            let v
            try {
              v = d.get.call(Notification)
            } catch {
              v = 'default'
            }
            return v === 'denied' ? 'default' : v
          }
        })
      }
    }
  } catch (err) {
    console.warn('[decky webview preload] Notification.permission spoof failed', err)
  }

  // navigator.permissions.query(notifications) — the matching half. The classic headless tell is
  // the IMPOSSIBLE pair "Notification.permission === 'denied'" with query state 'prompt'. Keep the
  // two consistent with the spoofed permission above (default⟷prompt, granted⟷granted), and pass
  // every other permission name straight through to the real implementation.
  try {
    const perms = navigator.permissions
    if (perms && typeof perms.query === 'function') {
      const origQuery = perms.query.bind(perms)
      const stateFor = () => {
        let p = 'default'
        try {
          p = (typeof Notification === 'function' && Notification.permission) || 'default'
        } catch {
          p = 'default'
        }
        return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt'
      }
      const query = function (desc) {
        if (desc && desc.name === 'notifications') {
          const proto =
            typeof PermissionStatus !== 'undefined' ? PermissionStatus.prototype : Object.prototype
          const status = Object.create(proto)
          // OWN data props via defineProperty — PermissionStatus.prototype.state is a getter-only
          // accessor, so a plain assignment would throw. Defining own props shadows it and keeps
          // `status instanceof PermissionStatus` true.
          Object.defineProperty(status, 'state', {
            value: stateFor(),
            enumerable: true,
            configurable: true
          })
          Object.defineProperty(status, 'name', {
            value: 'notifications',
            enumerable: true,
            configurable: true
          })
          Object.defineProperty(status, 'onchange', {
            value: null,
            writable: true,
            enumerable: true,
            configurable: true
          })
          return Promise.resolve(status)
        }
        return origQuery(desc)
      }
      try {
        query.toString = () => origQuery.toString()
      } catch {
        // best-effort masking
      }
      perms.query = query
    }
  } catch (err) {
    console.warn('[decky webview preload] permissions.query spoof failed', err)
  }

  // window.chrome — real Chrome exposes app / csi / loadTimes / runtime even on ordinary pages.
  // Electron leaves most of these undefined (only a hollow window.chrome). Google's sign-in
  // refuses with "browser may not be secure" when these are absent or stubbed too thinly —
  // a chrome object missing app/csi/loadTimes is a classic embedded/automation tell. Mocks
  // mirror puppeteer-extra-plugin-stealth's chrome.* evasions (same as decky-browser).
  try {
    const w = window
    if (!w.chrome) w.chrome = {}
    const c = w.chrome

    // chrome.runtime — present on every page in real Chrome; gates do `if (chrome.runtime)`.
    if (!c.runtime) {
      c.runtime = {
        OnInstalledReason: {
          CHROME_UPDATE: 'chrome_update',
          INSTALL: 'install',
          SHARED_MODULE_UPDATE: 'shared_module_update',
          UPDATE: 'update'
        },
        OnRestartRequiredReason: {
          APP_UPDATE: 'app_update',
          OS_UPDATE: 'os_update',
          PERIODIC: 'periodic'
        },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: {
          ANDROID: 'android',
          CROS: 'cros',
          LINUX: 'linux',
          MAC: 'mac',
          OPENBSD: 'openbsd',
          WIN: 'win'
        },
        RequestUpdateCheckStatus: {
          NO_UPDATE: 'no_update',
          THROTTLED: 'throttled',
          UPDATE_AVAILABLE: 'update_available'
        },
        // Arrow functions on purpose: native chrome.runtime.connect/sendMessage have NO `.prototype`
        // and are non-constructable (`new` throws TypeError). CreepJS's hasBadChromeRuntime gates on
        // exactly that — a plain `function () {}` has a prototype and IS constructable, flagging the
        // runtime as fake. Arrows mimic the native shape (Google's `if (chrome.runtime)` is fine).
        connect: () => {},
        sendMessage: () => {}
      }
    }

    // chrome.app — InstallState/RunningState enums + getDetails/getIsInstalled/isInstalled.
    if (!c.app) {
      c.app = {
        InstallState: {
          DISABLED: 'disabled',
          INSTALLED: 'installed',
          NOT_INSTALLED: 'not_installed'
        },
        RunningState: {
          CANNOT_RUN: 'cannot_run',
          READY_TO_RUN: 'ready_to_run',
          RUNNING: 'running'
        },
        getDetails: function () {
          return null
        },
        getIsInstalled: function () {
          return false
        },
        get isInstalled() {
          return false
        },
        runningState: function () {
          return 'cannot_run'
        }
      }
    }

    // chrome.csi() — returns page timing; real Chrome computes from performance.timing.
    if (!c.csi) {
      c.csi = function () {
        const t = performance.timing || {}
        const now = Date.now()
        const start = t.navigationStart || now
        return {
          startE: start,
          onloadT: t.domContentLoadedEventEnd || now,
          pageT: now - start,
          tran: 15
        }
      }
    }

    // chrome.loadTimes() — legacy timing object; bots famously lack it.
    if (!c.loadTimes) {
      c.loadTimes = function () {
        const t = performance.timing || {}
        const nav =
          (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {}
        const toSec = (ms) => (ms ? ms / 1000 : 0)
        const startSec = toSec(t.navigationStart || Date.now())
        return {
          get requestTime() {
            return startSec
          },
          get startLoadTime() {
            return startSec
          },
          get commitLoadTime() {
            return startSec + toSec(nav.responseStart || 0)
          },
          get finishDocumentLoadTime() {
            return startSec + toSec(nav.domContentLoadedEventEnd || 0)
          },
          get finishLoadTime() {
            return startSec + toSec(nav.loadEventEnd || 0)
          },
          get firstPaintTime() {
            return startSec
          },
          get firstPaintAfterLoadTime() {
            return 0
          },
          get navigationType() {
            return 'Other'
          },
          get wasFetchedViaSpdy() {
            return true
          },
          get wasNpnNegotiated() {
            return true
          },
          get npnNegotiatedProtocol() {
            return 'h2'
          },
          get wasAlternateProtocolAvailable() {
            return false
          },
          get connectionInfo() {
            return 'h2'
          }
        }
      }
    }
  } catch (err) {
    console.warn('[decky webview preload] window.chrome mock failed', err)
  }

  // Color-scheme: let nativeTheme.themeSource (set in main) drive what pages see via
  // prefers-color-scheme. No matchMedia override, no forced meta — sites get dark when the
  // host is dark, and decide for themselves what to render.
})()

// __meTracker — instrumentação de "página pronta" pros facilitadores de navegação do decky
// (settle/wait-request) e pro waitForSettled do handoff. Conta fetch/XHR em voo + marca última
// mutação de DOM, e mantém um ring buffer (≤100) dos requests CONCLUÍDOS pra alimentar
// `decky web wait-request`. Lido por src/main/web/facilitators.ts e pelo backend
// @handoff/runtime-electron. Roda no main world (contextIsolation off) pra enxergar fetch/XHR reais.
// ⚠️ DUP: sincronizado com TRACKER_SCRIPT de @handoff/runtime-electron (runtime/electron/src/tracker.ts);
// o `requests` ring buffer é uma extensão aditiva do decky (handoff conta requests via CDP).
;(() => {
  if (window.__meTracker) return
  let inFlight = 0
  let lastMutation = Date.now()
  // Ring buffer de requests concluídos: { url, method, status, startedAt, finishedAt, failed }.
  const requests = []
  const pushReq = (rec) => {
    requests.push(rec)
    if (requests.length > 100) requests.shift()
  }
  // Resolve URL relativa contra a página (o wait-request casa por URL absoluta).
  const absUrl = (u) => {
    try {
      return new URL(String(u), location.href).href
    } catch {
      return String(u)
    }
  }
  const origFetch = window.fetch ? window.fetch.bind(window) : null
  if (origFetch) {
    window.fetch = function (input, init) {
      if (init && init.keepalive) return origFetch(input, init)
      inFlight++
      const method = (init && init.method) || (input && input.method) || 'GET'
      const url = typeof input === 'string' ? input : (input && input.url) || String(input)
      const rec = {
        url: absUrl(url),
        method: String(method).toUpperCase(),
        status: 0,
        startedAt: Date.now(),
        finishedAt: undefined,
        failed: false
      }
      pushReq(rec)
      return origFetch(input, init).then(
        (r) => {
          inFlight--
          rec.status = r.status
          rec.finishedAt = Date.now()
          return r
        },
        (e) => {
          inFlight--
          rec.failed = true
          rec.finishedAt = Date.now()
          throw e
        }
      )
    }
  }
  const XHR = XMLHttpRequest.prototype
  const origOpen = XHR.open
  XHR.open = function (method, url, ...rest) {
    this.__meReq = { method: String(method || 'GET').toUpperCase(), url: absUrl(url || '') }
    return origOpen.call(this, method, url, ...rest)
  }
  const origSend = XHR.send
  XHR.send = function (...args) {
    if (!this.__meCounted) {
      this.__meCounted = true
      inFlight++
      const rec = {
        url: (this.__meReq && this.__meReq.url) || '',
        method: (this.__meReq && this.__meReq.method) || 'GET',
        status: 0,
        startedAt: Date.now(),
        finishedAt: undefined,
        failed: false
      }
      pushReq(rec)
      const xhr = this
      const dec = () => {
        inFlight--
        rec.status = xhr.status
        rec.finishedAt = Date.now()
        rec.failed = xhr.status === 0
      }
      this.addEventListener('loadend', dec, { once: true })
    }
    return origSend.apply(this, args)
  }
  const startObserver = () => {
    if (!document.documentElement) {
      setTimeout(startObserver, 10)
      return
    }
    try {
      const obs = new MutationObserver(() => {
        lastMutation = Date.now()
      })
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      })
    } catch {
      /* ignore */
    }
  }
  startObserver()
  window.__meTracker = {
    get inFlight() {
      return inFlight
    },
    get lastMutation() {
      return lastMutation
    },
    // Cópia rasa: o consumidor (main process) recebe um snapshot, não a referência viva.
    get requests() {
      return requests.slice()
    },
    debug: () => ({ inFlight, lastMutation, requests: requests.length })
  }
})()

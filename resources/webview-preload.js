// Stealth preload for the deckweb partition. Loaded via session.setPreloads in main, so it
// runs inside every web card's guest page BEFORE any page script executes — the only window
// where we can redefine globals like navigator.userAgentData that Google's account login
// checks. Pure DOM JS: no Electron / Node APIs (webview is sandboxed; importing them throws).

;(() => {
  try {
    // navigator.webdriver — the webview attribute disableblinkfeatures="AutomationControlled"
    // also covers this, but keeping it here means a regression on either layer alone is caught.
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true
    })
  } catch {
    // ignore — read-only on some engines
  }

  // navigator.userAgentData — the JS-side equivalent of Sec-CH-UA. Header spoof alone leaves
  // this returning "Chromium" + a Not:A-Brand filler, which Google's login flow inspects via
  // getHighEntropyValues() and refuses. Mirror the shape of a stock Chrome on this platform.
  try {
    const ua = navigator.userAgent || ''
    const m = /Chrome\/(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(ua)
    const major = m ? m[1] : '134'
    const fullVersion = m && m[2] ? `${major}.${m[2]}` : `${major}.0.0.0`
    const platform = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux'
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Not:A-Brand', version: '24' },
      { brand: 'Google Chrome', version: major }
    ]
    const fullBrands = brands.map((b) => ({ brand: b.brand, version: fullVersion }))

    const fakeUAD = {
      brands,
      mobile: false,
      platform,
      getHighEntropyValues(hints) {
        const out = { brands, mobile: false, platform }
        if (!Array.isArray(hints)) return Promise.resolve(out)
        if (hints.includes('platformVersion')) out.platformVersion = '14.5.0'
        if (hints.includes('architecture')) out.architecture = 'arm'
        if (hints.includes('model')) out.model = ''
        if (hints.includes('uaFullVersion')) out.uaFullVersion = fullVersion
        if (hints.includes('bitness')) out.bitness = '64'
        if (hints.includes('fullVersionList')) out.fullVersionList = fullBrands
        if (hints.includes('wow64')) out.wow64 = false
        return Promise.resolve(out)
      },
      toJSON() {
        return { brands, mobile: false, platform }
      }
    }
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => fakeUAD,
      configurable: true
    })
  } catch (err) {
    console.warn('[decky webview preload] userAgentData spoof failed', err)
  }

  // window.chrome — Chromium exposes a hollow object; real Chrome populates `runtime` (even on
  // non-extension pages). Sites that do `if (chrome.runtime)` as a "is this real Chrome" gate
  // will pass after this.
  try {
    const w = window
    if (w.chrome && !w.chrome.runtime) {
      w.chrome.runtime = { id: undefined, OnInstalledReason: {}, OnRestartRequiredReason: {} }
    }
  } catch {
    // ignore
  }
})()

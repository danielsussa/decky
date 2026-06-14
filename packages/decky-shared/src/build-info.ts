// Build identification — the short commit sha + ISO date of the bundle currently running.
// Injected by vite at compile time (see electron.vite.config.ts `define`). The build.sh script
// exports DECKY_BUILD_SHA / DECKY_BUILD_DATE before invoking the build; in `npm run dev` the
// vite config falls back to reading the current HEAD so the dev process also has a real value.
declare const __DECKY_BUILD_SHA__: string
declare const __DECKY_BUILD_DATE__: string

export interface BuildInfo {
  sha: string
  date: string
  label: string
}

export function getBuildInfo(): BuildInfo {
  const sha = __DECKY_BUILD_SHA__
  const date = __DECKY_BUILD_DATE__
  const label = date ? `${sha} · ${date}` : sha
  return { sha, date, label }
}

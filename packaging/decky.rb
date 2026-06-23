# Homebrew Cask for decky (Apple Silicon only).
#
# This file lives in the TAP repo (danielsussa/homebrew-decky) under Casks/decky.rb.
# It is kept here in the app repo as the source of truth; the release workflow renders
# it (filling the version + the arm64 DMG sha256) and pushes it to the tap on each
# release. The sha256 is filled from the published DMG:
#
#   shasum -a 256 decky-<version>-arm64.dmg
#
# Then users install with:
#   brew install --cask danielsussa/decky/decky
#
# Intel (x64) is not shipped: the cask has always been arm-only and the macos-13 CI
# runner stalled in queue, blocking the cask bump. To re-add Intel, restore the x64
# build matrix entry in release.yml, bring back `arch arm: "arm64", intel: "x64"` +
# a dual `sha256 arm:/intel:` here, and template the url with `#{arch}`.
cask "decky" do
  version "0.1.0"
  sha256 "REPLACE_WITH_ARM64_DMG_SHA256"

  url "https://github.com/danielsussa/decky/releases/download/v#{version}/decky-#{version}-arm64.dmg"
  name "decky"
  desc "Shell to drive the Claude agent + me CLI: terminal, Live View, files and todos in one panel"
  homepage "https://github.com/danielsussa/decky"

  depends_on arch: :arm64

  app "decky.app"

  zap trash: [
    "~/Library/Application Support/decky",
    "~/Library/Preferences/com.danielsussa.decky.plist",
    "~/Library/Saved Application State/com.danielsussa.decky.savedState",
    "~/.decky",
  ]
end

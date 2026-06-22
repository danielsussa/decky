# Homebrew Cask for decky.
#
# This file lives in the TAP repo (danielsussa/homebrew-decky) under Casks/decky.rb.
# It is kept here in the app repo as the source of truth; copy/update it into the tap
# on each release. The two sha256 values are filled from the published DMGs:
#
#   shasum -a 256 decky-<version>-arm64.dmg decky-<version>-x64.dmg
#
# Then users install with:
#   brew install --cask danielsussa/decky/decky
cask "decky" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_ARM64_DMG_SHA256",
         intel: "REPLACE_WITH_X64_DMG_SHA256"

  url "https://github.com/danielsussa/decky/releases/download/v#{version}/decky-#{version}-#{arch}.dmg"
  name "decky"
  desc "Shell to drive the Claude agent + me CLI: terminal, Live View, files and todos in one panel"
  homepage "https://github.com/danielsussa/decky"

  app "decky.app"

  zap trash: [
    "~/Library/Application Support/decky",
    "~/Library/Preferences/com.danielsussa.decky.plist",
    "~/Library/Saved Application State/com.danielsussa.decky.savedState",
    "~/.decky",
  ]
end

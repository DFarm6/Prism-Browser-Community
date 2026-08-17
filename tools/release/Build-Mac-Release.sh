#!/usr/bin/env bash

set -euo pipefail

kernel_app="${1:-}"
update_config="${2:-}"
[[ -d "$kernel_app" && "$kernel_app" == *.app ]] || { echo "Usage: $0 /path/to/Chromium.app /path/to/update-config.json" >&2; exit 2; }
[[ -f "$update_config" ]] || { echo "Signed update config is required." >&2; exit 2; }
[[ "${CSC_NAME:-}" == Developer\ ID\ Application:* ]] || { echo "CSC_NAME must select a Developer ID Application certificate." >&2; exit 2; }
if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    if [[ -z "${APPLE_KEYCHAIN:-}" || -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
      echo "Apple notarization credentials are incomplete." >&2
      exit 2
    fi
  fi
fi

project_root="$(cd "$(dirname "$0")/../.." && pwd)"
release_root="$project_root/release"
mkdir -p "$release_root"
staging="$(mktemp -d "$release_root/.mac-release-XXXXXX")"
trap 'rm -rf "$staging"' EXIT
staged_kernel="$staging/Chromium.app"
ditto "$kernel_app" "$staged_kernel"
"$project_root/tools/macos-kernel/Sign-Release-Build.sh" "$staged_kernel" "$CSC_NAME"

cd "$project_root"
npm ci
npm test
npm run build
export PRISM_BUNDLED_KERNEL_PATH="$staged_kernel"
export PRISM_REQUIRE_BUNDLED_KERNEL=1
export PRISM_UPDATE_CONFIG_PATH="$(cd "$(dirname "$update_config")" && pwd)/$(basename "$update_config")"
npx electron-builder --mac dmg zip --arm64 \
  -c.mac.forceCodeSigning=true \
  -c.mac.hardenedRuntime=true \
  -c.mac.notarize=true

app_path="$release_root/mac-arm64/Prism Browser.app"
PRISM_REQUIRE_DISTRIBUTION_SIGNATURE=1 "$project_root/tools/packaging/Verify-Mac-Package.sh" "$app_path"
release_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")"
release_dmg="$release_root/Prism Browser-$release_version-mac-arm64.dmg"
release_zip="$release_root/Prism Browser-$release_version-mac-arm64.zip"
[[ -f "$release_dmg" && -f "$release_zip" ]] || { echo "Expected versioned DMG and ZIP artifacts are missing." >&2; exit 1; }
shasum -a 256 "$release_dmg" "$release_zip" > "$release_root/SHA256SUMS-macos-arm64.txt"
team_identifier="$(codesign -dv --verbose=4 "$app_path" 2>&1 | awk -F= '/^TeamIdentifier=/ {print $2}')"
PRISM_RELEASE_VERSION="$release_version" PRISM_RELEASE_TEAM="$team_identifier" \
  PRISM_RELEASE_ROOT="$release_root" node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.PRISM_RELEASE_ROOT
const version = process.env.PRISM_RELEASE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const artifactPattern = new RegExp(`^Prism Browser-${version}-mac-arm64\\.(dmg|zip)$`)
const files = fs.readdirSync(root)
  .filter((name) => artifactPattern.test(name))
  .sort()
const report = {
  schemaVersion: 1,
  passed: files.length === 2,
  version: process.env.PRISM_RELEASE_VERSION,
  target: 'darwin-arm64',
  developerTeam: process.env.PRISM_RELEASE_TEAM,
  developerIdVerified: true,
  gatekeeperVerified: true,
  notarizationStapleVerified: true,
  updateConfigVerified: true,
  artifacts: files
}
if (!report.passed) throw new Error('Expected one DMG and one ZIP release artifact')
fs.writeFileSync(path.join(root, 'macos-release-acceptance.json'), JSON.stringify(report, null, 2) + '\n')
NODE
echo "Prism Browser macOS signed and notarized release completed: $release_root"

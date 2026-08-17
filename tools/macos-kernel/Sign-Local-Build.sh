#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/Chromium.app" >&2
  exit 2
fi

app_path="$1"
script_dir="$(cd "$(dirname "$0")" && pwd)"
entitlements_path="$script_dir/entitlements"
framework_path="$app_path/Contents/Frameworks/Chromium Framework.framework"
helpers_path="$framework_path/Helpers"
libraries_path="$framework_path/Libraries"

if [[ ! -x "$app_path/Contents/MacOS/Chromium" ]]; then
  echo "Chromium executable was not found in: $app_path" >&2
  exit 1
fi

sign() {
  codesign --force --sign - --timestamp=none "$@"
}

sign --identifier chrome_crashpad_handler "$helpers_path/chrome_crashpad_handler"
sign --identifier io.ungoogled-software.ungoogled-chromium.helper "$helpers_path/Chromium Helper.app"
sign --identifier io.ungoogled-software.ungoogled-chromium.helper.renderer \
  --entitlements "$entitlements_path/helper-renderer-entitlements.plist" \
  "$helpers_path/Chromium Helper (Renderer).app"
sign --identifier io.ungoogled-software.ungoogled-chromium.helper.gpu \
  --entitlements "$entitlements_path/helper-gpu-entitlements.plist" \
  "$helpers_path/Chromium Helper (GPU).app"
if [[ -d "$helpers_path/Chromium Helper (Plugin).app" ]]; then
  sign --identifier io.ungoogled-software.ungoogled-chromium.helper.plugin \
    --entitlements "$entitlements_path/helper-plugin-entitlements.plist" \
    "$helpers_path/Chromium Helper (Plugin).app"
fi
sign --identifier io.ungoogled-software.ungoogled-chromium.framework.AlertNotificationService \
  "$helpers_path/Chromium Helper (Alerts).app"
sign --identifier app_mode_loader "$helpers_path/app_mode_loader"
sign --identifier web_app_shortcut_copier "$helpers_path/web_app_shortcut_copier"
sign --identifier libEGL "$libraries_path/libEGL.dylib"
sign --identifier libGLESv2 "$libraries_path/libGLESv2.dylib"
sign --identifier libvk_swiftshader "$libraries_path/libvk_swiftshader.dylib"
sign --identifier io.ungoogled-software.ungoogled-chromium.framework "$framework_path"
sign --identifier io.ungoogled-software.ungoogled-chromium \
  --entitlements "$entitlements_path/app-entitlements.plist" "$app_path"

codesign --verify --deep --strict --verbose=2 "$app_path"
echo "Local Chromium bundle signed and verified: $app_path"

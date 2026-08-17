#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"

failures=0
check() {
  local label="$1" passed="$2" detail="$3"
  if [[ "$passed" == "1" ]]; then
    printf '[OK]   %s - %s\n' "$label" "$detail"
  else
    printf '[FAIL] %s - %s\n' "$label" "$detail"
    failures=$((failures + 1))
  fi
}

[[ -f "$lock_path" ]] || { echo "kernel-lock.json is missing" >&2; exit 1; }
chromium_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chromiumVersion"])' "$lock_path")"
check "Kernel lock" "1" "Chromium $chromium_version"

for command in git python3 ninja xcodebuild codesign shasum ditto; do
  if command -v "$command" >/dev/null 2>&1; then
    check "$command" "1" "$(command -v "$command")"
  else
    check "$command" "0" "not found"
  fi
done

if xcodebuild -license check >/dev/null 2>&1; then
  check "Xcode license" "1" "accepted"
else
  check "Xcode license" "0" "run sudo xcodebuild -license accept"
fi

mkdir -p "$build_root"
device="$(df "$build_root" | awk 'NR==2 {print $1}')"
filesystem="$(diskutil info "$device" 2>/dev/null | awk -F: '/File System Personality/ {gsub(/^[ \t]+/, "", $2); print $2}')"
if [[ "$filesystem" == "APFS" ]]; then
  check "Filesystem" "1" "$filesystem"
else
  check "Filesystem" "0" "${filesystem:-unknown}; APFS is required"
fi

free_kib="$(df -k "$build_root" | awk 'NR==2 {print $4}')"
free_gib=$((free_kib / 1024 / 1024))
if (( free_gib >= 180 )); then
  check "Free disk" "1" "${free_gib} GiB free"
else
  check "Free disk" "0" "${free_gib} GiB free; 180 GiB minimum, 300 GiB recommended"
fi

if [[ "$(uname -m)" == "arm64" ]]; then
  check "Architecture" "1" "arm64"
else
  check "Architecture" "0" "$(uname -m); this kit targets Apple silicon"
fi

if (( failures > 0 )); then
  echo "$failures prerequisite check(s) failed." >&2
  exit 1
fi
echo "macOS Chromium build prerequisites passed."

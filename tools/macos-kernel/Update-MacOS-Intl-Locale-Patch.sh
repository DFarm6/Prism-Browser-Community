#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
patch_path="$script_dir/patches/041-macos-intl-locale.patch"
[[ -f "$patch_path" ]] || patch_path="$script_dir/../kernel-patches/041-macos-intl-locale.patch"

read -r patch_hash < <(python3 - "$lock_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
print(next(item["sha256"] for item in lock["patches"] if item["file"] == "041-macos-intl-locale.patch"))
PY
)
[[ "$(shasum -a 256 "$patch_path" | awk '{print $1}')" == "$patch_hash" ]] || { echo "Unexpected patch 041 hash" >&2; exit 1; }

renderer_source="$source_path/content/renderer/renderer_main.cc"
[[ -f "$renderer_source" ]] || { echo "Prepared Chromium source is missing" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null 2>&1; then
  echo "The Chromium build is still running." >&2
  exit 1
fi

fingerprint_patch_dir="$fingerprint_path/patches/extra/fingerprint"
mkdir -p "$fingerprint_patch_dir"
cp "$patch_path" "$fingerprint_patch_dir/041-macos-intl-locale.patch"
python3 - "$lock_path" "$fingerprint_path/patches/series" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
path = sys.argv[2]
lines = open(path).read().splitlines()
managed = [patch["seriesPath"] for patch in lock["patches"]]
lines = [line for line in lines if line not in managed]
offsets = {}
for patch in lock["patches"]:
    anchor = patch.get("insertAfterSeriesPath", "extra/fingerprint/003-audio-fingerprint.patch")
    if anchor not in lines:
        raise SystemExit("fingerprint patch insertion anchor is missing: " + anchor)
    offset = offsets.get(anchor, 0)
    lines.insert(lines.index(anchor) + 1 + offset, patch["seriesPath"])
    offsets[anchor] = offset + 1
open(path, "w").write("\n".join(lines) + "\n")
PY

locale_marker=0; switch_marker=0
grep -Fq 'SetICUDefaultLocale(fingerprint_locale)' "$renderer_source" && locale_marker=1
grep -Fq 'switches::kFingerprintLanguage' "$renderer_source" && switch_marker=1
if (( locale_marker == 1 && switch_marker == 1 )); then
  echo "Patch 041 is already applied."
elif (( locale_marker == 0 && switch_marker == 0 )); then
  git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch_path"
  git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch_path"
else
  echo "Patch 041 is only partially applied." >&2
  exit 1
fi

contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$lock_path" "$repository_path/prism-build-lock.json" "$contract_sha" "$patch_hash" <<'PY'
import json, sys
contract = json.load(open(sys.argv[1]))
path = sys.argv[2]
lock = json.load(open(path))
lock["contractSha256"] = sys.argv[3]
lock["prismMacOSIntlLocalePatchSha256"] = sys.argv[4]
lock["patches"] = [{"id": p["id"], "file": p["file"], "sha256": p["sha256"]} for p in contract["patches"]]
open(path, "w").write(json.dumps(lock, indent=2) + "\n")
PY

echo "Prism macOS Intl locale patch is ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

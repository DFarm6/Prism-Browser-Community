#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
patch_path="$script_dir/patches/043-audio-noise-trap-authenticity.patch"
[[ -f "$patch_path" ]] || patch_path="$script_dir/../kernel-patches/043-audio-noise-trap-authenticity.patch"

read -r patch_hash < <(python3 - "$lock_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
print(next(item["sha256"] for item in lock["patches"] if item["file"] == "043-audio-noise-trap-authenticity.patch"))
PY
)
[[ "$(shasum -a 256 "$patch_path" | awk '{print $1}')" == "$patch_hash" ]] || { echo "Unexpected patch 043 hash" >&2; exit 1; }

audio_source="$source_path/third_party/blink/renderer/modules/webaudio/offline_audio_context.cc"
[[ -f "$audio_source" ]] || { echo "Prepared Chromium source is missing" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null 2>&1; then
  echo "The Chromium build is still running." >&2
  exit 1
fi

fingerprint_patch_dir="$fingerprint_path/patches/extra/fingerprint"
mkdir -p "$fingerprint_patch_dir"
cp "$patch_path" "$fingerprint_patch_dir/043-audio-noise-trap-authenticity.patch"
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

audio_marker=0
grep -Fq 'permutation_begin' "$audio_source" && audio_marker=1
if (( audio_marker == 1 )); then
  echo "Patch 043 is already applied."
else
  git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch_path"
  git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch_path"
fi

echo "Prism Audio noise-trap authenticity patch is ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

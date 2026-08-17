#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
patch_path="$script_dir/patches/042-native-canvas-audio-calibration.patch"
[[ -f "$patch_path" ]] || patch_path="$script_dir/../kernel-patches/042-native-canvas-audio-calibration.patch"

read -r patch_hash < <(python3 - "$lock_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
print(next(item["sha256"] for item in lock["patches"] if item["file"] == "042-native-canvas-audio-calibration.patch"))
PY
)
[[ "$(shasum -a 256 "$patch_path" | awk '{print $1}')" == "$patch_hash" ]] || { echo "Unexpected patch 042 hash" >&2; exit 1; }

canvas_source="$source_path/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc"
audio_source="$source_path/third_party/blink/renderer/modules/webaudio/offline_audio_context.cc"
[[ -f "$canvas_source" && -f "$audio_source" ]] || { echo "Prepared Chromium source is missing" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null 2>&1; then
  echo "The Chromium build is still running." >&2
  exit 1
fi

fingerprint_patch_dir="$fingerprint_path/patches/extra/fingerprint"
mkdir -p "$fingerprint_patch_dir"
cp "$patch_path" "$fingerprint_patch_dir/042-native-canvas-audio-calibration.patch"

canvas_marker=0; audio_marker=0
grep -Fq 'NormalizePrismCanvasLowEntropyCalibration' "$canvas_source" && canvas_marker=1
grep -Fq 'permutation_length' "$audio_source" && audio_marker=1
if (( canvas_marker == 1 && audio_marker == 1 )); then
  echo "Patch 042 is already applied."
elif (( canvas_marker == 0 && audio_marker == 0 )); then
  git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch_path"
  git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch_path"
else
  echo "Patch 042 is only partially applied." >&2
  exit 1
fi

echo "Prism native Canvas and Audio calibration patch is ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

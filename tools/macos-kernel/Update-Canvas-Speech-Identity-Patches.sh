#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
canvas_patch="$script_dir/patches/034-canvas-serialization-identity.patch"
speech_patch="$script_dir/patches/035-locale-speech-catalog.patch"
[[ -f "$canvas_patch" ]] || canvas_patch="$script_dir/../kernel-patches/034-canvas-serialization-identity.patch"
[[ -f "$speech_patch" ]] || speech_patch="$script_dir/../kernel-patches/035-locale-speech-catalog.patch"

IFS=$'\t' read -r expected_platform expected_fingerprint canvas_hash speech_hash < <(python3 - "$lock_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
patches = {item["file"]: item for item in lock["patches"]}
print("\t".join((
    lock["platforms"]["macos-arm64"]["commit"],
    lock["fingerprint"]["commit"],
    patches["034-canvas-serialization-identity.patch"]["sha256"],
    patches["035-locale-speech-catalog.patch"]["sha256"])))
PY
)

[[ "$(shasum -a 256 "$canvas_patch" | awk '{print $1}')" == "$canvas_hash" ]] || { echo "Unexpected patch 034 hash" >&2; exit 1; }
[[ "$(shasum -a 256 "$speech_patch" | awk '{print $1}')" == "$speech_hash" ]] || { echo "Unexpected patch 035 hash" >&2; exit 1; }
[[ "$(git -C "$repository_path" rev-parse HEAD)" == "$expected_platform" ]] || { echo "Unexpected macOS platform commit" >&2; exit 1; }
[[ "$(git -C "$fingerprint_path" rev-parse HEAD)" == "$expected_fingerprint" ]] || { echo "Unexpected fingerprint commit" >&2; exit 1; }
grep -Fq "ApplyRenderIdentityToWebGLSnapshot" "$source_path/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc" \
  || { echo "Patch 033 is missing" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null 2>&1; then
  echo "The Chromium build is still running." >&2
  exit 1
fi

fingerprint_patch_dir="$fingerprint_path/patches/extra/fingerprint"
mkdir -p "$fingerprint_patch_dir"
cp "$canvas_patch" "$fingerprint_patch_dir/034-canvas-serialization-identity.patch"
cp "$speech_patch" "$fingerprint_patch_dir/035-locale-speech-catalog.patch"
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

markers=(
  "third_party/blink/renderer/platform/graphics/image_data_buffer.cc:ApplyPrismCanvasSerializationIdentity"
  "third_party/blink/renderer/core/html/canvas/html_canvas_element.cc:data_buffer->ApplyPrismCanvasSerializationIdentity()"
  "third_party/blink/renderer/modules/speech/speech_synthesis.cc:UsesPrismLocaleVoiceCatalog"
  "third_party/blink/renderer/modules/speech/speech_synthesis.cc:Microsoft Haruka"
  "third_party/blink/renderer/modules/speech/speech_synthesis_voice.h:platformName()"
  "third_party/blink/renderer/modules/speech/speech_synthesis_utterance.cc:voice_->platformName()"
)
applied=0
for marker in "${markers[@]}"; do
  file="${marker%%:*}"
  value="${marker#*:}"
  grep -Fq "$value" "$source_path/$file" && applied=$((applied + 1))
done
if (( applied != 0 && applied != ${#markers[@]} )); then
  echo "Patches 034/035 are only partially applied." >&2
  exit 1
fi
if (( applied == 0 )); then
  for patch in "$canvas_patch" "$speech_patch"; do
    git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch"
    git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch"
  done
fi

contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$lock_path" "$repository_path/prism-build-lock.json" "$contract_sha" "$canvas_hash" "$speech_hash" <<'PY'
import json, sys
contract = json.load(open(sys.argv[1]))
path = sys.argv[2]
lock = json.load(open(path))
lock["contractSha256"] = sys.argv[3]
lock["prismCanvasSerializationIdentityPatchSha256"] = sys.argv[4]
lock["prismLocaleSpeechCatalogPatchSha256"] = sys.argv[5]
lock["patches"] = [
    {"id": patch["id"], "file": patch["file"], "sha256": patch["sha256"]}
    for patch in contract["patches"]
]
open(path, "w").write(json.dumps(lock, indent=2) + "\n")
PY

echo "Prism Canvas serialization and locale Speech catalog patches are ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

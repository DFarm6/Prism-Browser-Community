#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
patch_path="$script_dir/patches/033-webgl-snapshot-speech-coherence.patch"
[[ -f "$patch_path" ]] || patch_path="$script_dir/../kernel-patches/033-webgl-snapshot-speech-coherence.patch"
webgl_source="$source_path/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc"
speech_source="$source_path/third_party/blink/renderer/modules/speech/speech_synthesis.cc"

IFS=$'\t' read -r expected_platform_commit expected_fingerprint_commit expected_patch_hash < <(python3 - "$lock_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
patch = next(item for item in lock["patches"] if item["file"] == "033-webgl-snapshot-speech-coherence.patch")
print("\t".join((
    lock["platforms"]["macos-arm64"]["commit"],
    lock["fingerprint"]["commit"],
    patch["sha256"])))
PY
)

[[ -f "$patch_path" ]] || { echo "WebGL snapshot and speech coherence patch is missing: $patch_path" >&2; exit 1; }
[[ -f "$webgl_source" && -f "$speech_source" ]] || { echo "Prepared Chromium source is incomplete" >&2; exit 1; }
[[ "$(shasum -a 256 "$patch_path" | awk '{print $1}')" == "$expected_patch_hash" ]] \
  || { echo "Unexpected WebGL snapshot and speech coherence patch hash" >&2; exit 1; }
[[ "$(git -C "$repository_path" rev-parse HEAD)" == "$expected_platform_commit" ]] \
  || { echo "Unexpected macOS platform commit" >&2; exit 1; }
[[ "$(git -C "$fingerprint_path" rev-parse HEAD)" == "$expected_fingerprint_commit" ]] \
  || { echo "Unexpected fingerprint commit" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null 2>&1; then
  echo "The Chromium build is still running; wait before applying patch 033." >&2
  exit 1
fi

fingerprint_patch_dir="$fingerprint_path/patches/extra/fingerprint"
mkdir -p "$fingerprint_patch_dir"
cp "$patch_path" "$fingerprint_patch_dir/033-webgl-snapshot-speech-coherence.patch"
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

markers=(ApplyRenderIdentityToWebGLSnapshot top_left_rows)
applied=0
for marker in "${markers[@]}"; do
  grep -Fq "$marker" "$webgl_source" && applied=$((applied + 1))
done
grep -Fq 'render_identity != "v3" && render_identity != "v4"' "$speech_source" && applied=$((applied + 1))
if (( applied != 0 && applied != 3 )); then
  echo "The WebGL snapshot and speech coherence patch is only partially applied." >&2
  exit 1
fi
if (( applied == 0 )); then
  git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch_path"
  git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch_path"
fi

contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$lock_path" "$repository_path/prism-build-lock.json" "$contract_sha" "$expected_patch_hash" <<'PY'
import json, sys
contract = json.load(open(sys.argv[1]))
path = sys.argv[2]
lock = json.load(open(path))
lock["contractSha256"] = sys.argv[3]
lock["prismWebGlSnapshotSpeechCoherencePatchSha256"] = sys.argv[4]
lock["patches"] = [
    {"id": patch["id"], "file": patch["file"], "sha256": patch["sha256"]}
    for patch in contract["patches"]
]
open(path, "w").write(json.dumps(lock, indent=2) + "\n")
PY

echo "Prism WebGL snapshot and speech coherence patch is ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

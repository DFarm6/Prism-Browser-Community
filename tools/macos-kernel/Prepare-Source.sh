#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
patch_dir="$script_dir/patches"
[[ -f "$patch_dir/004-screen-size.patch" ]] || patch_dir="$script_dir/../kernel-patches"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"

lock_value() {
  python3 - "$lock_path" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)
PY
}

patch_value() {
  python3 - "$lock_path" "$1" "$2" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
patch = next((item for item in lock["patches"] if item["file"] == sys.argv[2]), None)
if patch is None:
    raise SystemExit("missing patch contract: " + sys.argv[2])
print(patch[sys.argv[3]])
PY
}

platform_repository="$(lock_value platforms.macos-arm64.repository)"
platform_tag="$(lock_value platforms.macos-arm64.tag)"
platform_commit="$(lock_value platforms.macos-arm64.commit)"
fingerprint_repository="$(lock_value fingerprint.repository)"
fingerprint_tag="$(lock_value fingerprint.tag)"
fingerprint_commit="$(lock_value fingerprint.commit)"
chromium_version="$(lock_value chromiumVersion)"

mkdir -p "$build_root"
if [[ ! -d "$repository_path/.git" ]]; then
  git clone --filter=blob:none --depth 1 --branch "$platform_tag" "$platform_repository" "$repository_path"
else
  unexpected_platform="$(git -C "$repository_path" status --porcelain --untracked-files=no \
    | grep -Ev '^( M \.gitmodules| M ungoogled-chromium)$' || true)"
  [[ -z "$unexpected_platform" ]] \
    || { echo "macOS platform repository has unexpected local changes:" >&2; echo "$unexpected_platform" >&2; exit 1; }
  git -C "$repository_path" checkout -- .gitmodules
fi
git -C "$repository_path" fetch --depth 1 origin "refs/tags/$platform_tag:refs/tags/$platform_tag"
git -C "$repository_path" checkout --detach "refs/tags/$platform_tag"
[[ "$(git -C "$repository_path" rev-parse HEAD)" == "$platform_commit" ]] \
  || { echo "Unexpected macOS platform commit" >&2; exit 1; }

if [[ ! -d "$fingerprint_path/.git" ]]; then
  git clone --filter=blob:none --depth 1 --branch "$fingerprint_tag" "$fingerprint_repository" "$fingerprint_path"
else
  unexpected="$(git -C "$fingerprint_path" status --porcelain | grep -Ev '^( M patches/series|\?\? patches/extra/fingerprint/(004-screen-size|005-screen-consistency|019-proxy-geolocation|020-render-identity-v1|021-conservative-render-identity-v2|022-profile-window-identity|023-coherent-render-identity-v3|024-domrect-seed-mixing|025-native-surface-consistency|026-canvas-seed-dispersion|027-direct-domrect-identity|028-direct-domrect-consumption|029-native-locale-surfaces-v4|030-windows-native-tts-voices|031-windows-tts-runtime|032-webgpu-template-identity|033-webgl-snapshot-speech-coherence|034-canvas-serialization-identity|035-locale-speech-catalog|036-coherent-canvas-readback|037-canvas-seed-slot-dispersion|038-webgl-calibration-authenticity|039-native-font-inventory-authenticity|040-domrect-calibration-authenticity|041-macos-intl-locale|042-native-canvas-audio-calibration|043-audio-noise-trap-authenticity|044-windows-taskbar-badge-readiness)\.patch)$' || true)"
  [[ -z "$unexpected" ]] || { echo "Fingerprint repository has unexpected local changes:" >&2; echo "$unexpected" >&2; exit 1; }
  git -C "$fingerprint_path" checkout -- patches/series
  rm -f \
    "$fingerprint_path/patches/extra/fingerprint/004-screen-size.patch" \
    "$fingerprint_path/patches/extra/fingerprint/005-screen-consistency.patch" \
    "$fingerprint_path/patches/extra/fingerprint/019-proxy-geolocation.patch" \
    "$fingerprint_path/patches/extra/fingerprint/020-render-identity-v1.patch" \
    "$fingerprint_path/patches/extra/fingerprint/021-conservative-render-identity-v2.patch" \
    "$fingerprint_path/patches/extra/fingerprint/022-profile-window-identity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/023-coherent-render-identity-v3.patch" \
    "$fingerprint_path/patches/extra/fingerprint/024-domrect-seed-mixing.patch" \
    "$fingerprint_path/patches/extra/fingerprint/025-native-surface-consistency.patch" \
    "$fingerprint_path/patches/extra/fingerprint/026-canvas-seed-dispersion.patch" \
    "$fingerprint_path/patches/extra/fingerprint/027-direct-domrect-identity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/028-direct-domrect-consumption.patch" \
    "$fingerprint_path/patches/extra/fingerprint/029-native-locale-surfaces-v4.patch" \
    "$fingerprint_path/patches/extra/fingerprint/030-windows-native-tts-voices.patch" \
    "$fingerprint_path/patches/extra/fingerprint/031-windows-tts-runtime.patch" \
    "$fingerprint_path/patches/extra/fingerprint/032-webgpu-template-identity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/033-webgl-snapshot-speech-coherence.patch" \
    "$fingerprint_path/patches/extra/fingerprint/034-canvas-serialization-identity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/035-locale-speech-catalog.patch" \
    "$fingerprint_path/patches/extra/fingerprint/036-coherent-canvas-readback.patch" \
    "$fingerprint_path/patches/extra/fingerprint/037-canvas-seed-slot-dispersion.patch" \
    "$fingerprint_path/patches/extra/fingerprint/038-webgl-calibration-authenticity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/039-native-font-inventory-authenticity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/040-domrect-calibration-authenticity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/041-macos-intl-locale.patch" \
    "$fingerprint_path/patches/extra/fingerprint/042-native-canvas-audio-calibration.patch" \
    "$fingerprint_path/patches/extra/fingerprint/043-audio-noise-trap-authenticity.patch" \
    "$fingerprint_path/patches/extra/fingerprint/044-windows-taskbar-badge-readiness.patch"
  git -C "$fingerprint_path" fetch --depth 1 origin "refs/tags/$fingerprint_tag:refs/tags/$fingerprint_tag"
  git -C "$fingerprint_path" checkout --detach "refs/tags/$fingerprint_tag"
fi
[[ "$(git -C "$fingerprint_path" rev-parse HEAD)" == "$fingerprint_commit" ]] \
  || { echo "Unexpected fingerprint commit" >&2; exit 1; }
[[ "$(tr -d '[:space:]' < "$fingerprint_path/chromium_version.txt")" == "$chromium_version" ]] \
  || { echo "Unexpected Chromium version" >&2; exit 1; }

mkdir -p "$fingerprint_path/patches/extra/fingerprint"
while IFS= read -r patch; do
  expected="$(patch_value "$patch" sha256)"
  actual="$(shasum -a 256 "$patch_dir/$patch" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "Patch hash mismatch: $patch" >&2; exit 1; }
  cp "$patch_dir/$patch" "$fingerprint_path/patches/extra/fingerprint/$patch"
done < <(python3 - "$lock_path" <<'PY'
import json, sys
for patch in json.load(open(sys.argv[1]))["patches"]:
    print(patch["file"])
PY
)

python3 - "$lock_path" "$fingerprint_path/patches/series" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
series_path = sys.argv[2]
lines = open(series_path).read().splitlines()
managed = [patch["seriesPath"] for patch in lock["patches"]]
lines = [line for line in lines if line not in managed]
offsets = {}
for patch in lock["patches"]:
    anchor = patch.get(
        "insertAfterSeriesPath",
        "extra/fingerprint/003-audio-fingerprint.patch")
    if anchor not in lines:
        raise SystemExit("fingerprint patch insertion anchor is missing: " + anchor)
    offset = offsets.get(anchor, 0)
    lines.insert(lines.index(anchor) + 1 + offset, patch["seriesPath"])
    offsets[anchor] = offset + 1
open(series_path, "w").write("\n".join(lines) + "\n")
PY

git -C "$repository_path" config submodule.ungoogled-chromium.url "$fingerprint_repository"
contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$lock_path" "$repository_path/prism-build-lock.json" "$contract_sha" <<'PY'
import datetime, json, sys
contract = json.load(open(sys.argv[1]))
platform = contract["platforms"]["macos-arm64"]
lock = {
    "schemaVersion": 5,
    "contractSchemaVersion": contract["schemaVersion"],
    "contractSha256": sys.argv[3],
    "chromiumVersion": contract["chromiumVersion"],
    "target": "macos-arm64",
    "platformRepository": platform["repository"],
    "platformTag": platform["tag"],
    "platformCommit": platform["commit"],
    "fingerprintRepository": contract["fingerprint"]["repository"],
    "fingerprintTag": contract["fingerprint"]["tag"],
    "fingerprintCommit": contract["fingerprint"]["commit"],
    "patches": [{"id": p["id"], "file": p["file"], "sha256": p["sha256"]} for p in contract["patches"]],
    "preparedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()
}
open(sys.argv[2], "w").write(json.dumps(lock, indent=2) + "\n")
PY

echo "Pinned macOS source is ready: $repository_path"
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

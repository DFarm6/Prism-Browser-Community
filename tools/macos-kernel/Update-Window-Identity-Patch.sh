#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
patch_dir="$script_dir/patches"
[[ -f "$patch_dir/022-profile-window-identity.patch" ]] || patch_dir="$script_dir/../kernel-patches"
patch_path="$patch_dir/022-profile-window-identity.patch"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
series_path="$fingerprint_path/patches/series"
build_lock_path="$repository_path/prism-build-lock.json"

[[ -f "$patch_path" && -d "$repository_path/.git" && -d "$fingerprint_path/.git" \
  && -d "$source_path" && -f "$build_lock_path" ]] \
  || { echo "Prepared Prism macOS Chromium source was not found under $build_root" >&2; exit 1; }
if pgrep -f "ninja.*$source_path/out/Default" >/dev/null; then
  echo "Chromium is still compiling. Wait for Ninja to finish before applying the patch." >&2
  exit 1
fi

python3 - "$lock_path" "$patch_path" "$repository_path" "$fingerprint_path" <<'PY'
import hashlib, json, os, subprocess, sys
lock_path, patch_path, repository_path, fingerprint_path = sys.argv[1:]
lock = json.load(open(lock_path))
patch = next(item for item in lock["patches"] if item["file"] == os.path.basename(patch_path))
actual = hashlib.sha256(open(patch_path, "rb").read()).hexdigest()
if actual != patch["sha256"]:
    raise SystemExit("Profile window identity patch hash mismatch")
if subprocess.check_output(["git", "-C", repository_path, "rev-parse", "HEAD"], text=True).strip() != lock["platforms"]["macos-arm64"]["commit"]:
    raise SystemExit("Unexpected macOS platform source commit")
if subprocess.check_output(["git", "-C", fingerprint_path, "rev-parse", "HEAD"], text=True).strip() != lock["fingerprint"]["commit"]:
    raise SystemExit("Unexpected fingerprint source commit")
PY

mkdir -p "$fingerprint_path/patches/extra/fingerprint"
cp "$patch_path" "$fingerprint_path/patches/extra/fingerprint/022-profile-window-identity.patch"
python3 - "$lock_path" "$series_path" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
path = sys.argv[2]
lines = open(path).read().splitlines()
managed = [item["seriesPath"] for item in lock["patches"]]
lines = [line for line in lines if line not in managed]
offsets = {}
for patch in lock["patches"]:
    anchor = patch.get("insertAfterSeriesPath", "extra/fingerprint/003-audio-fingerprint.patch")
    if anchor not in lines:
        raise SystemExit("Missing patch insertion anchor: " + anchor)
    offset = offsets.get(anchor, 0)
    lines.insert(lines.index(anchor) + 1 + offset, patch["seriesPath"])
    offsets[anchor] = offset + 1
open(path, "w").write("\n".join(lines) + "\n")
PY

markers=(
  "$source_path/chrome/browser/ui/views/frame/browser_view.cc:prism-profile-serial"
  "$source_path/chrome/browser/ui/views/frame/browser_window_property_manager_win.cc:com.prismbrowser.profile."
  "$source_path/chrome/browser/ui/views/toolbar/toolbar_view.cc:Prism profile identity: mirror"
  "$source_path/chrome/browser/ui/views/frame/browser_native_widget_mac.mm:dockTile.badgeLabel"
)
marker_count=0
for marker in "${markers[@]}"; do
  file="${marker%%:*}"
  text="${marker#*:}"
  grep -Fq "$text" "$file" && ((marker_count += 1)) || true
done
if (( marker_count != 0 && marker_count != ${#markers[@]} )); then
  echo "The profile window identity patch is only partially applied." >&2
  exit 1
fi
if (( marker_count == 0 )); then
  git -C "$repository_path" apply --check --unsafe-paths --directory=build/src "$patch_path"
  git -C "$repository_path" apply --unsafe-paths --directory=build/src "$patch_path"
fi

contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$lock_path" "$build_lock_path" "$contract_sha" <<'PY'
import json, sys
contract = json.load(open(sys.argv[1]))
path = sys.argv[2]
lock = json.load(open(path))
lock["contractSha256"] = sys.argv[3]
lock["patches"] = [
    {"id": item["id"], "file": item["file"], "sha256": item["sha256"]}
    for item in contract["patches"]
]
open(path, "w").write(json.dumps(lock, indent=2) + "\n")
PY

echo "Prism profile window identity patch is ready."
echo "Next: ./Build-Kernel.sh \"$build_root\" 4"

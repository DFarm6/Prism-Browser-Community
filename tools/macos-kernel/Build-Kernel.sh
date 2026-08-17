#!/usr/bin/env bash

set -euo pipefail

build_root="${1:-/Volumes/disk/prism-kernel}"
jobs="${2:-4}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] && (( jobs <= 64 )) || { echo "Jobs must be 1-64" >&2; exit 2; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
lock_path="$script_dir/kernel-lock.json"
[[ -f "$lock_path" ]] || lock_path="$script_dir/../kernel-lock.json"
repository_path="$build_root/ungoogled-chromium-macos"
fingerprint_path="$repository_path/ungoogled-chromium"
source_path="$repository_path/build/src"
output_path="$source_path/out/Default"
build_ninja="$output_path/build.ninja"
chromium_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chromiumVersion"])' "$lock_path")"
artifact_dir="$build_root/artifacts/$chromium_version-macos-arm64"
log_dir="$build_root/logs"
mkdir -p "$log_dir" "$artifact_dir"
timestamp="$(date -u +%Y%m%d-%H%M%S)"
log_path="$log_dir/macos-kernel-$timestamp.log"
state_path="$log_dir/macos-kernel-latest.json"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exec > >(tee -a "$log_path") 2>&1

write_state() {
  local status="$1" message="$2"
  python3 - "$state_path" "$status" "$message" "$started_at" "$log_path" "$artifact_dir" <<'PY'
import datetime, json, sys
value = {
    "schemaVersion": 1,
    "status": sys.argv[2],
    "message": sys.argv[3],
    "startedAtUtc": sys.argv[4],
    "updatedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "log": sys.argv[5],
    "artifacts": sys.argv[6]
}
open(sys.argv[1], "w").write(json.dumps(value, indent=2) + "\n")
PY
}
trap 'code=$?; if (( code != 0 )); then write_state failed "Build failed with exit code $code; rerun the same command to resume"; fi' EXIT
write_state running "Build started"

verify_args=(
  verify-source
  --platform macos-arm64
  --platform-root "$repository_path"
  --fingerprint-root "$fingerprint_path"
)
if [[ -f "$build_ninja" ]]; then
  verify_args+=(--chromium-source "$source_path")
fi
node "$script_dir/../kernel-maintenance/run.mjs" "${verify_args[@]}"

if [[ -f "$build_ninja" ]]; then
  echo "Existing Ninja graph found. Resuming incremental build..."
  ninja -C "$output_path" -j "$jobs" chrome chromedriver
else
  echo "No Ninja graph found. Starting the pinned first build..."
  (cd "$repository_path" && ./build.sh arm64)
fi

app_path="$output_path/Chromium.app"
driver_path="$output_path/chromedriver"
args_path="$output_path/args.gn"
[[ -x "$app_path/Contents/MacOS/Chromium" && -x "$driver_path" && -f "$args_path" ]] \
  || { echo "Expected build outputs are missing" >&2; exit 1; }
"$script_dir/Sign-Local-Build.sh" "$app_path"

zip_path="$artifact_dir/Chromium-$chromium_version-macos-arm64.zip"
rm -f "$zip_path" "$artifact_dir/chromedriver" "$artifact_dir/args.gn" \
  "$artifact_dir/prism-build-lock.json" "$artifact_dir/manifest.json" "$artifact_dir/SHA256SUMS.txt"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"
cp "$driver_path" "$artifact_dir/chromedriver"
cp "$args_path" "$artifact_dir/args.gn"
cp "$repository_path/prism-build-lock.json" "$artifact_dir/prism-build-lock.json"

contract_sha="$(shasum -a 256 "$lock_path" | awk '{print $1}')"
python3 - "$artifact_dir" "$chromium_version" "$contract_sha" "$jobs" <<'PY'
import datetime, hashlib, json, os, sys
root, version, contract_sha, jobs = sys.argv[1:]
payload = sorted(name for name in os.listdir(root) if name not in {"manifest.json", "SHA256SUMS.txt"})
files = []
for name in payload:
    path = os.path.join(root, name)
    if not os.path.isfile(path):
        continue
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    files.append({"name": name, "size": os.path.getsize(path), "sha256": digest.hexdigest()})
lock = json.load(open(os.path.join(root, "prism-build-lock.json")))
manifest = {
    "schemaVersion": 2,
    "chromiumVersion": version,
    "target": "macos-arm64",
    "contractSha256": contract_sha,
    "platformCommit": lock["platformCommit"],
    "fingerprintCommit": lock["fingerprintCommit"],
    "jobs": int(jobs),
    "completedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "files": files
}
open(os.path.join(root, "manifest.json"), "w").write(json.dumps(manifest, indent=2) + "\n")
PY

(cd "$artifact_dir" && shasum -a 256 Chromium-*.zip chromedriver args.gn prism-build-lock.json manifest.json > SHA256SUMS.txt)
write_state completed "Build and artifact verification completed"
trap - EXIT
echo "macOS fingerprint Chromium build completed."
echo "Artifacts: $artifact_dir"
echo "Build log: $log_path"

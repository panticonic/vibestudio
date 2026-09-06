#!/usr/bin/env bash
# Hosted desktop tests need an unlocked keychain, just as an interactive login
# session does. Keep synthetic test credentials separate from the runner's
# existing Electron items and retain the application's normal item access ACL.
set -euo pipefail
if [[ "$(uname -s)" != Darwin || $# -eq 0 ]]; then
  echo 'Usage (macOS only): with-macos-test-keychain.sh command [args...]' >&2
  exit 2
fi

previous_default=$(security default-keychain -d user | sed -E 's/^[[:space:]]*"(.*)"[[:space:]]*$/\1/')
previous_search_list=$(security list-keychains -d user)
previous_keychains=()
while IFS= read -r entry; do
  entry=$(printf '%s' "$entry" | sed -E 's/^[[:space:]]*"(.*)"[[:space:]]*$/\1/')
  if [[ -n "$entry" ]]; then previous_keychains+=("$entry"); fi
done <<< "$previous_search_list"
keychain_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vibestudio-test-keychain.XXXXXX")
keychain_path="$keychain_dir/desktop.keychain-db"
keychain_created=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$keychain_created" == true ]]; then
    security default-keychain -d user -s "$previous_default" || status=1
    security list-keychains -d user -s "${previous_keychains[@]}" || status=1
    security delete-keychain "$keychain_path" || status=1
  fi
  rmdir "$keychain_dir" || status=1
  exit "$status"
}
trap cleanup EXIT
# Never export or log this throwaway password. No provider credentials are used.
keychain_password=$(openssl rand -hex 32)
security create-keychain -p "$keychain_password" "$keychain_path"
keychain_created=true
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
unset keychain_password
security default-keychain -d user -s "$keychain_path"
# Do not accidentally find a stale Electron item in another runner keychain.
# System trust roots remain in the separate system keychain domain.
security list-keychains -d user -s "$keychain_path"
# Contract: electron/electron v43.2.0 shell/browser/electron_browser_main_parts.cc
# and chromium 150.0.7871.129 components/os_crypt/common/keychain_password_mac.mm.
# Electron names its generic-password item from app.getName(); our
# branded desktop sets "Vibestudio". Seed only synthetic CI encryption material.
# Chromium generates this same Base64-encoded 128-bit password on first use.
# Provisioning an exact application ACL prevents a first-use Keychain dialog
# from blocking the unattended main thread. Never use security's allow-all -A.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node --input-type=module -e '
  const {resolveElectronExecutableForVibestudio} = await import(process.argv[1]);
  const {writeFileSync} = await import("node:fs");
  writeFileSync(process.argv[2], resolveElectronExecutableForVibestudio());
' "$script_dir/branded-electron.mjs" "$keychain_dir/electron-path"
electron_binary=$(cat "$keychain_dir/electron-path")
rm "$keychain_dir/electron-path"
safe_storage_password=$(openssl rand -base64 16)
security add-generic-password -a Vibestudio -s 'Vibestudio Safe Storage' \
  -w "$safe_storage_password" -T "$electron_binary" "$keychain_path"
unset safe_storage_password
echo '[desktop-smoke] Using an isolated unlocked macOS test keychain'
"$@"

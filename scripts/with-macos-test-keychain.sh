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
echo '[desktop-smoke] Using an isolated unlocked macOS test keychain'
"$@"

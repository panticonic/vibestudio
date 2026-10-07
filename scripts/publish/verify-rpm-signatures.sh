#!/usr/bin/env bash
# Verify package signatures against only the repository's configured public key.
set -euo pipefail
RELEASE_DIR=${1:?usage: verify-rpm-signatures.sh <release-dir>}
SIGNING_KEY=${SIGNING_KEY:-packages@vibestudio.app}
verification_root=$(mktemp -d)
trap 'rm -rf "$verification_root"' EXIT
gpg --batch --armor --export "$SIGNING_KEY" > "$verification_root/key.gpg"
test -s "$verification_root/key.gpg"
rpm --dbpath "$verification_root/rpmdb" --import "$verification_root/key.gpg"
shopt -s nullglob
packages=("$RELEASE_DIR"/*.rpm)
test "${#packages[@]}" -gt 0
for package in "${packages[@]}"; do
  result=$(rpm --dbpath "$verification_root/rpmdb" --checksig --verbose "$package")
  printf '%s\n' "$result"
  # Unsigned packages can pass digest verification; require a verified signature.
  printf '%s\n' "$result" | grep -E 'Signature.*: OK$' > /dev/null
done

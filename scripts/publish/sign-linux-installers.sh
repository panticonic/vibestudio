#!/usr/bin/env bash
# Sign once before publication, then checksum the final immutable installers.
set -euo pipefail
RELEASE_DIR=${1:?usage: sign-linux-installers.sh <release-dir>}
SIGNING_KEY=${SIGNING_KEY:-packages@vibestudio.app}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rpm --define "_gpg_name $SIGNING_KEY" --define "__gpg $(command -v gpg)" --addsign "$RELEASE_DIR"/*.rpm
bash "$SCRIPT_DIR/verify-rpm-signatures.sh" "$RELEASE_DIR"
(
  cd "$RELEASE_DIR"
  sha256sum ./*.deb ./*.rpm ./*.pkg.tar.zst > SHA256SUMS-linux
)

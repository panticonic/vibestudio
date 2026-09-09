#!/bin/sh
# Install the AppArmor profile that lets a workspace runtime create its sandbox.
# Best-effort: a host without AppArmor is not a failed installation, and a
# refused profile must never leave the package half-configured.
set -e

PROFILE_NAME=vibestudio-mxc
PROFILE_SOURCE="/opt/Vibestudio/resources/apparmor/${PROFILE_NAME}"
PROFILE_TARGET="/etc/apparmor.d/${PROFILE_NAME}"

if [ ! -f "$PROFILE_SOURCE" ] || [ ! -d /etc/apparmor.d ]; then
  exit 0
fi

install -m 0644 "$PROFILE_SOURCE" "$PROFILE_TARGET"

if command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser --replace --skip-cache "$PROFILE_TARGET" || \
    echo "vibestudio: could not load $PROFILE_TARGET; workspaces may not start until AppArmor reloads it" >&2
fi

exit 0

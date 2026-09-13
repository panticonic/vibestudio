#!/bin/sh
# Install the AppArmor profile that lets a workspace runtime create its sandbox.
# Best-effort: a host without AppArmor is not a failed installation, and a
# refused profile must never leave the package half-configured.
set -e

if [ ! -d /etc/apparmor.d ]; then
  exit 0
fi

# vibestudio-mxc lets a workspace runtime create its bubblewrap sandbox;
# vibestudio lets the desktop create the one Chromium sandboxes renderers in,
# which also covers every development client it launches from that same binary.
for PROFILE_NAME in vibestudio-mxc vibestudio; do
  PROFILE_SOURCE="/opt/Vibestudio/resources/apparmor/${PROFILE_NAME}"
  PROFILE_TARGET="/etc/apparmor.d/${PROFILE_NAME}"
  [ -f "$PROFILE_SOURCE" ] || continue

  install -m 0644 "$PROFILE_SOURCE" "$PROFILE_TARGET"

  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --replace --skip-cache "$PROFILE_TARGET" || \
      echo "vibestudio: could not load $PROFILE_TARGET; the sandbox it covers may refuse to start until AppArmor reloads it" >&2
  fi
done

exit 0

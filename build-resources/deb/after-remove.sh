#!/bin/sh
# Withdraw the AppArmor profile with the package that installed it.
set -e

PROFILE_NAME=vibestudio-mxc
PROFILE_TARGET="/etc/apparmor.d/${PROFILE_NAME}"

case "$1" in
  remove | purge)
    if [ -f "$PROFILE_TARGET" ]; then
      if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser --remove "$PROFILE_TARGET" || true
      fi
      rm -f "$PROFILE_TARGET"
    fi
    ;;
esac

exit 0

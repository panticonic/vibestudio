#!/bin/sh
# Withdraw the AppArmor profile with the package that installed it.
#
# The argument is not spelled the same way across formats: dpkg passes
# "remove"/"purge" (and "upgrade"), while rpm passes a remaining-install count,
# 0 on uninstall and 1 on upgrade. Keep the profile through an upgrade under
# either convention, and remove it only when the package is actually going away.
set -e

PROFILE_NAME=vibestudio-mxc
PROFILE_TARGET="/etc/apparmor.d/${PROFILE_NAME}"

case "${1:-remove}" in
  remove | purge | 0) ;;
  *) exit 0 ;;
esac

if [ -f "$PROFILE_TARGET" ]; then
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --remove "$PROFILE_TARGET" || true
  fi
  rm -f "$PROFILE_TARGET"
fi

exit 0

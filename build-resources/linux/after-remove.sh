#!/bin/sh
# Withdraw the AppArmor profiles with the package that installed them.
#
# The argument is not spelled the same way across formats: dpkg passes
# "remove"/"purge" (and "upgrade"), while rpm passes a remaining-install count,
# 0 on uninstall and 1 on upgrade. Keep the profile through an upgrade under
# either convention, and remove it only when the package is actually going away.
set -e

case "${1:-remove}" in
  remove | purge | 0) ;;
  *) exit 0 ;;
esac

for PROFILE_NAME in vibestudio-mxc vibestudio; do
  PROFILE_TARGET="/etc/apparmor.d/${PROFILE_NAME}"
  [ -f "$PROFILE_TARGET" ] || continue
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --remove "$PROFILE_TARGET" || true
  fi
  rm -f "$PROFILE_TARGET"
done

exit 0

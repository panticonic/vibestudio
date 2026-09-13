#!/bin/bash
# Maintainer removal for every packaged Linux format.
#
# electron-builder uses this INSTEAD of its own after-remove template, so it
# has to withdraw everything the default withdraws — the binary link and the
# desktop's AppArmor profile — as well as the workspace runtime's profile,
# which the default knows nothing about.
#
# The argument is not spelled the same way across formats: dpkg passes
# "remove"/"purge" (and "upgrade"), while rpm passes a remaining-install count,
# 0 on uninstall and 1 on upgrade. Keep everything through an upgrade under
# either convention, and withdraw only when the package is actually going away.

case "${1:-remove}" in
  remove | purge | 0) ;;
  *) exit 0 ;;
esac

# Delete the link to the binary. update-alternatives --remove takes the
# registered alternative binary, not the generic symlink.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

for PROFILE_TARGET in '/etc/apparmor.d/${executable}' /etc/apparmor.d/vibestudio-mxc; do
  [ -f "$PROFILE_TARGET" ] || continue
  # Unload from the running kernel before deleting the file, so the policy is
  # not left enforced until the next reboot. Live AppArmor operations are not
  # meaningful inside a chroot.
  if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
    apparmor_parser --remove "$PROFILE_TARGET" || true
  fi
  rm -f "$PROFILE_TARGET"
done

exit 0

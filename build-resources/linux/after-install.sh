#!/bin/bash
# Maintainer install for every packaged Linux format.
#
# electron-builder uses this INSTEAD of its own after-install template
# (FpmTarget's getResource falls back to the default only when no script is
# configured), so everything the default does has to live here too. It is
# templated the same way, so ${executable} and ${sanitizedProductName} are
# substituted at package time.
#
# Beyond the default it installs the AppArmor profile a workspace runtime needs
# to create its bubblewrap sandbox. The desktop's own profile — which lets
# Chromium sandbox renderers in a user namespace — is the one electron-builder
# generates, and is installed below exactly as the default does.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install the desktop's AppArmor profile. (Ubuntu 24+)
# First check that this host's AppArmor supports the profile's abi, keeping
# backwards compatibility with 22.04, where the app runs fine without it.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Live AppArmor operations are not meaningful inside a chroot, where images
    # for clients are maintained rather than run.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# The workspace runtime's own profile, which the default template knows nothing
# about. Best-effort: a host without AppArmor is not a failed installation, and
# a refused profile must never leave the package half-configured.
MXC_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor/vibestudio-mxc'
MXC_PROFILE_TARGET='/etc/apparmor.d/vibestudio-mxc'
if [ -f "$MXC_PROFILE_SOURCE" ] && [ -d /etc/apparmor.d ]; then
  install -m 0644 "$MXC_PROFILE_SOURCE" "$MXC_PROFILE_TARGET"
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --replace --skip-cache "$MXC_PROFILE_TARGET" || \
      echo "vibestudio: could not load $MXC_PROFILE_TARGET; workspaces may not start until AppArmor reloads it" >&2
  fi
fi

exit 0

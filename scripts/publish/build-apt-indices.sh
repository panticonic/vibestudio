#!/usr/bin/env bash
# Index architectures from Debian control metadata, independently of filenames.
set -euo pipefail
APT_ROOT=${1:?usage: build-apt-indices.sh <apt-root> <suite>}
SUITE=${2:?usage: build-apt-indices.sh <apt-root> <suite>}
cd "$APT_ROOT"
packages=$(mktemp)
trap 'rm -f "$packages"' EXIT
# Keep every architecture of the same package/version in the input catalog.
dpkg-scanpackages --multiversion pool > "$packages"
for arch in amd64 arm64; do
  destination="dists/$SUITE/main/binary-$arch"
  mkdir -p "$destination"
  awk -v arch="$arch" '
    BEGIN { RS=""; FS="\n"; ORS="\n\n" }
    { for (i=1; i<=NF; i++)
        if ($i == "Architecture: " arch || $i == "Architecture: all") { print; break }
    }
  ' "$packages" > "$destination/Packages"
  if ! grep -q '^Package:' "$destination/Packages"; then
    printf '[linux-repos] no packages for required architecture %s\n' "$arch" >&2
    exit 1
  fi
  gzip -9fkn "$destination/Packages"
  printf '[linux-repos] indexed %s: %s package(s)\n' "$arch" \
    "$(grep -c '^Package:' "$destination/Packages")" >&2
done

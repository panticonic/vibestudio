#!/usr/bin/env bash
# Assemble signed apt and dnf repositories from a release directory.
#
# Linux users expect updates through their package manager, not an in-app
# updater, and electron-updater only handles AppImage on Linux anyway. Serving
# signed repositories is what makes `apt upgrade` and `dnf upgrade` carry a new
# Vibestudio the way they carry everything else.
#
# The published tree holds the packages of one release. That is enough for
# upgrades, which only read the current index; it does not support installing or
# rolling back to an older version. Accumulating a pool across releases means
# reading the previously published tree first, and is a deliberate next step
# rather than an accident of this one.
set -euo pipefail

RELEASE_DIR=${1:?usage: build-linux-repos.sh <release-dir> <output-dir> <base-url>}
OUTPUT_DIR=${2:?usage: build-linux-repos.sh <release-dir> <output-dir> <base-url>}
BASE_URL=${3:?usage: build-linux-repos.sh <release-dir> <output-dir> <base-url>}
SIGNING_KEY=${SIGNING_KEY:-packages@vibestudio.app}
SUITE=${SUITE:-stable}
COMPONENT=main

log() { printf '[linux-repos] %s\n' "$1" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    log "missing required tool: $1"
    exit 1
  }
}

require gpg
require apt-ftparchive
require dpkg-scanpackages

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------- apt --------
APT_ROOT="$OUTPUT_DIR/apt"
POOL="$APT_ROOT/pool/$COMPONENT/v/vibestudio"
mkdir -p "$POOL"

deb_count=0
while IFS= read -r -d '' deb; do
  cp "$deb" "$POOL/"
  deb_count=$((deb_count + 1))
done < <(find "$RELEASE_DIR" -maxdepth 1 -type f -name '*.deb' -print0)

if [ "$deb_count" -eq 0 ]; then
  log "no .deb found in $RELEASE_DIR"
  exit 1
fi
log "staged $deb_count deb(s)"

# dpkg-scanpackages emits paths relative to its working directory, and those
# paths are what apt fetches, so it must run from the repository root.
for arch in amd64 arm64; do
  dist_dir="$APT_ROOT/dists/$SUITE/$COMPONENT/binary-$arch"
  mkdir -p "$dist_dir"
  (
    cd "$APT_ROOT"
    dpkg-scanpackages --arch "$arch" pool 2>/dev/null \
      > "dists/$SUITE/$COMPONENT/binary-$arch/Packages"
  )
  gzip -9fkn "$dist_dir/Packages"
  log "indexed $arch: $(grep -c '^Package:' "$dist_dir/Packages" || true) package(s)"
done

apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=Vibestudio" \
  -o "APT::FTPArchive::Release::Label=Vibestudio" \
  -o "APT::FTPArchive::Release::Suite=$SUITE" \
  -o "APT::FTPArchive::Release::Codename=$SUITE" \
  -o "APT::FTPArchive::Release::Architectures=amd64 arm64" \
  -o "APT::FTPArchive::Release::Components=$COMPONENT" \
  -o "APT::FTPArchive::Release::Description=Vibestudio desktop and server packages" \
  release "$APT_ROOT/dists/$SUITE" > "$APT_ROOT/dists/$SUITE/Release"

# InRelease is the inline-signed index modern apt prefers; Release.gpg keeps
# older clients working against the same tree.
gpg --batch --yes --local-user "$SIGNING_KEY" \
  --clearsign --output "$APT_ROOT/dists/$SUITE/InRelease" "$APT_ROOT/dists/$SUITE/Release"
gpg --batch --yes --local-user "$SIGNING_KEY" \
  --detach-sign --armor --output "$APT_ROOT/dists/$SUITE/Release.gpg" \
  "$APT_ROOT/dists/$SUITE/Release"
log "signed apt indices"

# ---------------------------------------------------------------- dnf --------
RPM_ROOT="$OUTPUT_DIR/rpm"
mkdir -p "$RPM_ROOT"
rpm_count=0
while IFS= read -r -d '' rpm_file; do
  cp "$rpm_file" "$RPM_ROOT/"
  rpm_count=$((rpm_count + 1))
done < <(find "$RELEASE_DIR" -maxdepth 1 -type f -name '*.rpm' -print0)

if [ "$rpm_count" -gt 0 ]; then
  require createrepo_c
  # Sign the packages themselves as well as the index: dnf verifies package
  # signatures independently of repository metadata.
  if command -v rpm >/dev/null 2>&1; then
    rpm --define "_gpg_name $SIGNING_KEY" --addsign "$RPM_ROOT"/*.rpm >/dev/null
    log "signed $rpm_count rpm(s)"
  fi
  createrepo_c --quiet "$RPM_ROOT"
  gpg --batch --yes --local-user "$SIGNING_KEY" \
    --detach-sign --armor "$RPM_ROOT/repodata/repomd.xml"
  log "signed dnf metadata"
else
  log "no .rpm found; skipping the dnf repository"
fi

# ------------------------------------------------------------- key + docs ----
gpg --armor --export "$SIGNING_KEY" > "$OUTPUT_DIR/gpg.key"
grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$OUTPUT_DIR/gpg.key"
# A repository that accidentally publishes a private key is unrecoverable, so
# fail loudly rather than serve one.
if grep -q "PRIVATE KEY" "$OUTPUT_DIR/gpg.key"; then
  log "refusing to publish: exported key contains private material"
  exit 1
fi

cat > "$OUTPUT_DIR/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<title>Vibestudio packages</title>
<style>
 body{font:14px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem}
 pre{background:#f5f5f5;padding:.85rem 1rem;overflow-x:auto;border-radius:6px}
 h2{margin-top:2.25rem}
</style>
<h1>Vibestudio packages</h1>
<p>Signed apt and dnf repositories. Updates arrive through your package manager.</p>
<h2>Debian / Ubuntu</h2>
<pre>sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL $BASE_URL/gpg.key | sudo tee /etc/apt/keyrings/vibestudio.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/vibestudio.asc] $BASE_URL/apt $SUITE $COMPONENT" \\
  | sudo tee /etc/apt/sources.list.d/vibestudio.list
sudo apt update &amp;&amp; sudo apt install vibestudio</pre>
<h2>Fedora / RHEL / openSUSE</h2>
<pre>sudo rpm --import $BASE_URL/gpg.key
sudo tee /etc/yum.repos.d/vibestudio.repo &lt;&lt;'REPO'
[vibestudio]
name=Vibestudio
baseurl=$BASE_URL/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$BASE_URL/gpg.key
REPO
sudo dnf install vibestudio</pre>
<h2>Arch</h2>
<p>Arch packages are attached to each <a href="https://github.com/panticonic/vibestudio/releases">GitHub release</a>.</p>
HTML

log "repositories written to $OUTPUT_DIR"

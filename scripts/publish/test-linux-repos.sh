#!/usr/bin/env bash
# Exercise publication with real packages, signatures, and repository tools.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
export GNUPGHOME="$test_root/gnupg"
mkdir -m 700 "$GNUPGHOME"
trap 'gpgconf --kill gpg-agent; rm -rf "$test_root"' EXIT
export SIGNING_KEY=publication-test@example.invalid
gpg --batch --passphrase '' --quick-generate-key "$SIGNING_KEY" rsa2048 sign 0
mkdir -p "$test_root/release" "$test_root/rpmbuild/SPECS"
for arch in amd64 arm64; do
  mkdir -p "$test_root/deb-$arch/DEBIAN"
  printf 'Package: vibestudio\nVersion: 1.0.0\nArchitecture: %s\nMaintainer: Test <test@example.invalid>\nDescription: Publication fixture\n' "$arch" > "$test_root/deb-$arch/DEBIAN/control"
  dpkg-deb --build "$test_root/deb-$arch" "$test_root/release/vibestudio-$arch.deb"
done
cat > "$test_root/rpmbuild/SPECS/fixture.spec" <<'SPEC'
Name: vibestudio
Version: 1.0.0
Release: 1
Summary: Publication fixture
License: MIT
BuildArch: noarch
%description
Publication fixture
%install
mkdir -p %{buildroot}/usr/share/vibestudio
echo fixture > %{buildroot}/usr/share/vibestudio/fixture
%files
/usr/share/vibestudio/fixture
SPEC
rpmbuild --define "_topdir $test_root/rpmbuild" -bb "$test_root/rpmbuild/SPECS/fixture.spec"
cp "$test_root/rpmbuild/RPMS/noarch/"*.rpm "$test_root/release/"
printf 'Arch fixture\n' > "$test_root/release/vibestudio.pkg.tar.zst"
if bash "$SCRIPT_DIR/verify-rpm-signatures.sh" "$test_root/release"; then
  echo 'Unsigned package was accepted' >&2
  exit 1
fi
bash "$SCRIPT_DIR/sign-linux-installers.sh" "$test_root/release"
(cd "$test_root/release" && sha256sum --check SHA256SUMS-linux)
assets_url=https://github.com/example/repo/releases/download/v1.0.0
bash "$SCRIPT_DIR/build-linux-repos.sh" "$test_root/release" "$test_root/site" https://example.invalid "$assets_url"
gpg --verify "$test_root/site/apt/dists/stable/InRelease"
gpg --verify "$test_root/site/rpm/repodata/repomd.xml.asc" "$test_root/site/rpm/repodata/repomd.xml"
test -z "$(find "$test_root/site/rpm" -name '*.rpm' -print)"
python3 - "$test_root/site" "$test_root/release" "$assets_url/" <<'PY'
import gzip, hashlib, pathlib, sys, xml.etree.ElementTree as ET
site, release, origin = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
ns = {'repo': 'http://linux.duke.edu/metadata/repo', 'pkg': 'http://linux.duke.edu/metadata/common'}
repo = ET.parse(site / 'rpm/repodata/repomd.xml')
primary = repo.find('repo:data[@type="primary"]/repo:location', ns).attrib['href']
with gzip.open(site / 'rpm' / primary) as f:
    metadata = ET.parse(f)
packages = metadata.findall('pkg:package', ns)
assert len(packages) == 1
for package in packages:
    location = package.find('pkg:location', ns)
    assert location.attrib['{http://www.w3.org/XML/1998/namespace}base'] == origin
    payload = release / location.attrib['href']
    assert package.find('pkg:checksum', ns).text == hashlib.sha256(payload.read_bytes()).hexdigest()
for arch in ['amd64', 'arm64']:
    index = (site / f'apt/dists/stable/main/binary-{arch}/Packages').read_text()
    assert f'Architecture: {arch}\n' in index
    assert f'Filename: pool/main/v/vibestudio/vibestudio-{arch}.deb\n' in index
PY
# Modifying a payload after signing must fail verification.
python3 - "$test_root/release" <<'PY'
import pathlib, sys
package = next(pathlib.Path(sys.argv[1]).glob('*.rpm'))
payload = bytearray(package.read_bytes())
payload[-1] ^= 1
package.write_bytes(payload)
PY
if bash "$SCRIPT_DIR/verify-rpm-signatures.sh" "$test_root/release"; then
  echo 'Modified package was accepted' >&2
  exit 1
fi
echo 'Linux publication integration passed'

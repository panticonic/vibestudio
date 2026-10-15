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
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(date +%s)
export DEPLOYMENT_EPOCH=$SOURCE_DATE_EPOCH
bash "$SCRIPT_DIR/build-linux-repos.sh" "$test_root/release" "$test_root/site" https://example.invalid "$assets_url"
gpg --verify "$test_root/site/apt/dists/stable/InRelease"
gpg --verify "$test_root/site/rpm/repodata/repomd.xml.asc" "$test_root/site/rpm/repodata/repomd.xml"
test -z "$(find "$test_root/site/rpm" -name '*.rpm' -print)"
same_release_epoch=$SOURCE_DATE_EPOCH
bash "$SCRIPT_DIR/build-linux-repos.sh" "$test_root/release" "$test_root/site-repeat" https://example.invalid "$assets_url"
cmp "$test_root/site/rpm/repodata/repomd.xml" "$test_root/site-repeat/rpm/repodata/repomd.xml"
cmp "$test_root/site/rpm/repodata/repomd.xml.asc" "$test_root/site-repeat/rpm/repodata/repomd.xml.asc"
SOURCE_DATE_EPOCH=$((same_release_epoch + 1))
DEPLOYMENT_EPOCH=$((DEPLOYMENT_EPOCH + 60))
bash "$SCRIPT_DIR/build-linux-repos.sh" "$test_root/release" "$test_root/site-next" https://example.invalid "$assets_url" "$test_root/site/rpm"
mkdir -p "$test_root/published"
cp -a "$test_root/site-next/rpm" "$test_root/published/rpm"
cp "$test_root/site/rpm/repodata/retention.json" "$test_root/published/rpm/repodata/retention.json"
python3 "$SCRIPT_DIR/fetch-rpm-repodata.py" \
  "file://$test_root/published/rpm" "$test_root/captured" "$DEPLOYMENT_EPOCH" 86400
gpg --verify "$test_root/captured/repodata/repomd.xml.asc" "$test_root/captured/repodata/repomd.xml"
python3 - "$test_root/site" "$test_root/site-next" "$test_root/captured" "$test_root/release" "$assets_url/" <<'PY'
import gzip, hashlib, pathlib, re, sys, xml.etree.ElementTree as ET
site = pathlib.Path(sys.argv[1])
next_site = pathlib.Path(sys.argv[2])
captured = pathlib.Path(sys.argv[3])
release = pathlib.Path(sys.argv[4])
origin = sys.argv[5]
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
retention = __import__('json').loads((next_site / 'rpm/repodata/retention.json').read_text())
retained = {record['path']: record for record in retention['files']}
old_references = set()
for record in repo.findall('repo:data', ns):
    relative = record.find('repo:location', ns).attrib['href']
    checksum = record.find('repo:checksum', ns).text
    old_references.add(relative)
    assert retained[relative]['sha256'] == checksum
    assert hashlib.sha256((next_site / 'rpm' / relative).read_bytes()).hexdigest() == checksum
next_repo = ET.parse(next_site / 'rpm/repodata/repomd.xml')
new_references = {
    record.find('repo:location', ns).attrib['href']
    for record in next_repo.findall('repo:data', ns)
}
captured_manifest = __import__('json').loads((captured / 'repodata/retention.json').read_text())
captured_references = {record['path'] for record in captured_manifest['files']}
assert captured_references == old_references | new_references
for arch in ['amd64', 'arm64']:
    index = (site / f'apt/dists/stable/main/binary-{arch}/Packages').read_text()
    assert f'Architecture: {arch}\n' in index
    assert f'Filename: pool/main/v/vibestudio/vibestudio-{arch}.deb\n' in index
release_text = (site / 'apt/dists/stable/Release').read_text()
assert re.search(r'^Acquire-By-Hash: yes$', release_text, re.MULTILINE)
sha256_section = release_text.split('SHA256:\n', 1)[1].split('\nSHA512:\n', 1)[0]
indexes = []
for line in sha256_section.splitlines():
    digest, size, relative = line.split()
    canonical = site / 'apt/dists/stable' / relative
    assert canonical.stat().st_size == int(size)
    assert hashlib.sha256(canonical.read_bytes()).hexdigest() == digest
    by_hash = canonical.parent / 'by-hash/SHA256' / digest
    assert by_hash.read_bytes() == canonical.read_bytes()
    indexes.append(relative)
assert indexes
assert set(indexes) == {
    'main/binary-amd64/Packages',
    'main/binary-amd64/Packages.gz',
    'main/binary-arm64/Packages',
    'main/binary-arm64/Packages.gz',
}
downloads = (site / 'index.html').read_text()
assert 'arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/vibestudio.asc' in downloads
assert '<h2>Fedora &amp; RHEL</h2>' in downloads
assert 'gpgcheck=1\nrepo_gpgcheck=1\n' in downloads
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

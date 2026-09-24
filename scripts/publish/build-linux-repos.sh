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

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cp "$SCRIPT_ROOT/build-resources/brand/vibestudio-symbol.svg" \
  "$OUTPUT_DIR/vibestudio-symbol.svg"

cat > "$OUTPUT_DIR/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#110f18">
<meta name="description" content="Install Vibestudio on Debian, Ubuntu, Fedora, RHEL, and openSUSE using signed Linux packages.">
<link rel="icon" type="image/svg+xml" href="./vibestudio-symbol.svg">
<title>Install Vibestudio for Linux</title>
<style>
 :root{color-scheme:dark;--bg:#110f18;--panel:#1b1724;--line:#342b40;--ink:#f8f5fc;--muted:#b8afc4;--purple:#bb9afa;--pink:#f394bd}
 *{box-sizing:border-box}
 html{background:var(--bg);scroll-behavior:smooth}
 body{margin:0;background:radial-gradient(ellipse at 72% 0,rgba(129,72,190,.19),transparent 36rem),var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
 a{color:#ddcaff}
 .wrap{width:min(100% - 40px,960px);margin:0 auto}
 .topbar{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.09)}
 .brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-size:18px;font-weight:700;letter-spacing:-.04em}
 .brand img{width:30px;height:30px;display:block}
 .toplink{font-size:14px;color:#d4c5e8;text-decoration:none}
 .hero{padding:75px 0 43px;max-width:760px}
 .eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#d6bfff;font-weight:700}
 h1{font-size:clamp(42px,7vw,68px);letter-spacing:-.06em;line-height:1.05;margin:15px 0 17px}
 .lede{max-width:670px;font-size:18px;color:#d0c8d8;margin:0}
 .trust{display:flex;gap:10px;flex-wrap:wrap;margin-top:23px}
 .badge{border:1px solid #514362;background:rgba(31,25,42,.72);border-radius:999px;padding:5px 11px;color:#e7dff0;font-size:12px}
 .section-title{font-size:22px;letter-spacing:-.035em;margin:25px 0 16px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .card{min-width:0;padding:22px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(145deg,rgba(37,30,49,.96),rgba(25,21,34,.96));box-shadow:0 18px 54px rgba(0,0,0,.14)}
 .card-head{display:flex;align-items:center;gap:11px;margin-bottom:15px}
 .os-icon{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:#332643;color:#e2caff;font-size:15px;font-weight:750}
 h2{font-size:19px;line-height:1.25;letter-spacing:-.03em;margin:0}
 .card p{color:var(--muted);font-size:14px;margin:0 0 15px}
 .step-label{margin:17px 0 7px;color:#ddd1eb;font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
 pre{max-width:100%;margin:0;padding:14px 15px;border:1px solid #40364c;border-radius:9px;background:#100e15;color:#eee8f5;font:12px/1.75 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;overflow:auto;tab-size:2}
 .arch{margin-top:20px;padding:19px 22px;border:1px solid var(--line);border-radius:12px;background:rgba(27,23,36,.75);color:var(--muted);font-size:14px}
 .arch strong{color:var(--ink)}
 .arch p{margin:4px 0 0}
 footer{margin-top:56px;padding:20px 0 30px;border-top:1px solid rgba(255,255,255,.09);display:flex;justify-content:space-between;gap:20px;color:#a99fb4;font-size:13px}
 footer a{color:#d4c5e8;text-decoration:none}
 @media(max-width:700px){.grid{grid-template-columns:1fr}.hero{padding:57px 0 32px}.card{padding:18px}}
 @media(max-width:420px){.wrap{width:min(100% - 28px,960px)}.topbar{height:66px}.hero{padding-top:45px}.lede{font-size:16px}footer{display:block}footer span{display:block;margin-top:6px}}
</style>
 </head>
 <body>
 <header class="wrap topbar">
   <a class="brand" href="https://vibestudio.app/"><img src="./vibestudio-symbol.svg" alt="">Vibestudio</a>
   <a class="toplink" href="https://github.com/panticonic/vibestudio/releases">All releases ↗</a>
 </header>
 <main class="wrap">
   <section class="hero" aria-labelledby="page-title">
     <div class="eyebrow">Linux packages</div>
     <h1 id="page-title">Vibestudio, at home on Linux.</h1>
     <p class="lede">Install with the package manager you already use. Signed packages and repository metadata keep updates flowing through your normal system updates.</p>
     <div class="trust"><span class="badge">Signed repositories</span><span class="badge">Automatic package updates</span><span class="badge">x86_64 and ARM64</span></div>
   </section>
   <section aria-labelledby="install-title">
     <h2 class="section-title" id="install-title">Choose your package manager</h2>
     <div class="grid">
       <article class="card">
         <div class="card-head"><div class="os-icon" aria-hidden="true">D</div><h2>Debian &amp; Ubuntu</h2></div>
         <p>Add the signed Vibestudio repository, then install and update with APT.</p>
         <div class="step-label">Run in Terminal</div>
         <pre><code>sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL $BASE_URL/gpg.key | sudo tee /etc/apt/keyrings/vibestudio.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/vibestudio.asc] $BASE_URL/apt $SUITE $COMPONENT" \\
  | sudo tee /etc/apt/sources.list.d/vibestudio.list
sudo apt update &amp;&amp; sudo apt install vibestudio</code></pre>
       </article>
       <article class="card">
         <div class="card-head"><div class="os-icon" aria-hidden="true">F</div><h2>Fedora, RHEL &amp; openSUSE</h2></div>
         <p>Register the signed repository, then use DNF to install and receive updates.</p>
         <div class="step-label">Run in Terminal</div>
         <pre><code>sudo rpm --import $BASE_URL/gpg.key
sudo tee /etc/yum.repos.d/vibestudio.repo &lt;&lt;'REPO'
[vibestudio]
name=Vibestudio
baseurl=$BASE_URL/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$BASE_URL/gpg.key
REPO
sudo dnf install vibestudio</code></pre>
       </article>
     </div>
     <aside class="arch"><strong>Arch Linux</strong><p>Download the Arch package attached to the <a href="https://github.com/panticonic/vibestudio/releases">latest GitHub release</a>.</p></aside>
   </section>
 </main>
 <footer class="wrap"><a href="https://vibestudio.app/">Vibestudio</a><span>Questions or issues? <a href="https://github.com/panticonic/vibestudio/issues">Get help on GitHub</a></span></footer>
 </body>
</html>
HTML

log "repositories written to $OUTPUT_DIR"

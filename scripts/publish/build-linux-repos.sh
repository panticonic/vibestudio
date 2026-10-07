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
PACKAGE_BASE_URL=${4:?usage: build-linux-repos.sh <release-dir> <output-dir> <base-url> <release-assets-url>}
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
SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

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
bash "$SCRIPT_ROOT/scripts/publish/build-apt-indices.sh" "$APT_ROOT" "$SUITE"

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
  require rpm
  bash "$SCRIPT_ROOT/scripts/publish/verify-rpm-signatures.sh" "$RPM_ROOT"
  # DNF reads the signed index here and fetches the exact, already signed release
  # assets. Hosting a second copy would exceed GitHub Pages' 1 GB site limit.
  createrepo_c --quiet --baseurl "${PACKAGE_BASE_URL%/}/" "$RPM_ROOT"
  gpg --batch --yes --local-user "$SIGNING_KEY" \
    --detach-sign --armor "$RPM_ROOT/repodata/repomd.xml"
  rm "$RPM_ROOT"/*.rpm
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

for symbol in vibestudio-symbol.svg vibestudio-symbol-dark.svg; do
  cp "$SCRIPT_ROOT/build-resources/brand/$symbol" "$OUTPUT_DIR/$symbol"
done

cat > "$OUTPUT_DIR/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6F2EA" media="(prefers-color-scheme: light)" data-scheme="light">
<meta name="theme-color" content="#1A202A" media="(prefers-color-scheme: dark)" data-scheme="dark">
<meta name="description" content="Download Vibestudio for macOS and Windows, install through Homebrew, or use signed Linux package repositories.">
<link rel="icon" type="image/svg+xml" href="./vibestudio-symbol.svg">
<title>Download Vibestudio</title>
<script>
 (() => {
   const root = document.documentElement;
   const system = matchMedia("(prefers-color-scheme: dark)");
   const valid = (theme) => (theme === "light" || theme === "dark" ? theme : null);
   const params = new URLSearchParams(location.search);
   let chosen = valid(params.get("theme"));
   if (chosen) {
     try { localStorage.setItem("theme", chosen); } catch {}
     params.delete("theme");
     history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
   } else {
     try { chosen = valid(localStorage.getItem("theme")); } catch {}
   }
   const apply = () => {
     if (chosen) root.dataset.theme = chosen; else delete root.dataset.theme;
     for (const element of document.querySelectorAll("[data-scheme]")) {
       const scheme = element.dataset.scheme;
       element.media = chosen ? (chosen === scheme ? "all" : "not all") : "(prefers-color-scheme: " + scheme + ")";
     }
     for (const link of document.querySelectorAll("a[data-carry-theme]")) {
       const url = new URL(link.href);
       if (chosen) url.searchParams.set("theme", chosen); else url.searchParams.delete("theme");
       link.href = url.href;
     }
     const toggle = document.getElementById("theme-toggle");
     if (toggle) toggle.setAttribute("aria-pressed", String((chosen ?? (system.matches ? "dark" : "light")) === "dark"));
   };
   apply();
   system.addEventListener("change", apply);
   document.addEventListener("DOMContentLoaded", () => {
     apply();
     document.getElementById("theme-toggle").addEventListener("click", () => {
       const dark = (chosen ?? (system.matches ? "dark" : "light")) === "dark";
       chosen = dark ? "light" : "dark";
       try { localStorage.setItem("theme", chosen); } catch {}
       apply();
     });
   });
 })();
</script>
<style>
 :root{color-scheme:light dark;--bg:light-dark(#F6F2EA,#1A202A);--paper:light-dark(#FFFDF8,#222A36);--line:light-dark(#E0D8C9,#36414F);--ink:light-dark(#14243D,#F1EEE8);--muted:light-dark(#56627A,#B8C0CB);--primary:light-dark(#204FA3,#496FA8);--primary-hover:light-dark(#183E83,#5A7FB8);--link:light-dark(#204FA3,#AFC8F0);--signal:light-dark(#C73F2D,#E8A08F);--signal-soft:light-dark(#F7DED6,#3D2C2F);--tint:light-dark(#E6EDF8,#232F42);--shadow-sm:0 14px 34px -18px light-dark(#14243D40,#0009);--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
 :root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
 *{box-sizing:border-box}
 html{background:var(--bg);scroll-behavior:smooth}
 body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
 a{color:var(--link);text-underline-offset:3px}
 button:focus-visible,a:focus-visible{outline:3px solid var(--link);outline-offset:4px}
 .wrap{width:min(100% - 48px,1040px);margin:0 auto}
 .topbar{height:84px;display:flex;align-items:center;justify-content:space-between;gap:20px}
 .brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-size:21px;font-weight:750;letter-spacing:-.04em}
 .brand img{width:24px;height:32px;display:block}
 .topnav{display:flex;align-items:center;gap:22px}
 .toplink{font-size:15px;font-weight:600;color:var(--link);text-decoration:none}
 .toplink:hover{text-decoration:underline}
 .theme-toggle{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--paper);color:var(--ink);cursor:pointer;transition:border-color .15s}
 .theme-toggle:hover{border-color:var(--primary)}
 .theme-toggle svg{width:18px;height:18px}
 .hero{padding:56px 0 64px;text-align:center}
 .kicker{display:block;margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--signal)}
 h1{font-size:clamp(44px,7vw,80px);font-weight:750;letter-spacing:-.05em;line-height:1;margin:0 0 22px}
 .lede{max-width:36em;margin:0 auto;font-size:19px;color:var(--muted)}
 .actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:32px}
 .button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:11px 24px;border:1px solid var(--line);border-radius:999px;font-size:15px;font-weight:650;white-space:nowrap;text-decoration:none;transition:transform .15s,box-shadow .15s,background .15s,border-color .15s}
 .button:hover{transform:translateY(-1px)}
 .primary{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:0 10px 24px -10px var(--primary)}
 .primary:hover{background:var(--primary-hover)}
 .secondary{background:var(--paper);color:var(--ink)}
 .secondary:hover{border-color:var(--primary)}
 .fine{margin:18px 0 0;font-size:14px;color:var(--muted)}
 section+section{margin-top:56px}
 .section-title{font-size:clamp(26px,3.4vw,34px);font-weight:750;letter-spacing:-.035em;line-height:1.1;margin:0 0 20px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .card{min-width:0;padding:26px;border:1px solid var(--line);border-radius:16px;background:var(--paper);transition:box-shadow .2s,border-color .2s}
 .card:hover{box-shadow:var(--shadow-sm);border-color:color-mix(in srgb,var(--primary) 40%,var(--line))}
 .card-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}
 .os-icon{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--tint);color:var(--link);font:700 14px var(--mono)}
 .grid .card:nth-child(even) .os-icon{background:var(--signal-soft);color:var(--signal)}
 h2{font-size:20px;font-weight:700;line-height:1.25;letter-spacing:-.02em;margin:0}
 .card p{color:var(--muted);font-size:15px;margin:0 0 14px}
 .step-label{margin:20px 0 8px;color:var(--signal);font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
 pre{max-width:100%;margin:0;padding:14px 16px;border-radius:12px;background:var(--tint);color:var(--ink);font:12.5px/1.75 var(--mono);white-space:pre;overflow:auto;tab-size:2}
 .arch{margin-top:16px;padding:20px 26px;border:1px solid var(--line);border-radius:16px;background:var(--paper);color:var(--muted);font-size:15px}
 .arch strong{color:var(--ink)}
 .arch p{margin:4px 0 0}
 footer{margin-top:72px;padding:24px 0 40px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:14px}
 footer a{color:var(--link);text-decoration:none}
 @media(max-width:700px){.grid{grid-template-columns:1fr}.hero{padding:36px 0 48px}.card{padding:20px}.actions .button{flex:1}}
 @media(max-width:420px){.wrap{width:min(100% - 32px,1040px)}.topbar{height:72px}.lede{font-size:17px}footer{display:block}footer span{display:block;margin-top:6px}}
 @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.button,.card{transition:none}.button:hover{transform:none}}
</style>
 </head>
 <body>
 <header class="wrap topbar">
   <a class="brand" href="https://vibestudio.app/" data-carry-theme><picture><source media="(prefers-color-scheme: dark)" data-scheme="dark" srcset="./vibestudio-symbol-dark.svg"><img src="./vibestudio-symbol.svg" alt=""></picture>Vibestudio</a>
   <div class="topnav"><a class="toplink" href="https://github.com/panticonic/vibestudio/releases">All releases ↗</a><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Dark mode" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg></button></div>
 </header>
 <main class="wrap">
   <section class="hero" aria-labelledby="page-title">
     <span class="kicker">Desktop downloads</span>
     <h1 id="page-title">Get Vibestudio.</h1>
     <p class="lede">Download the desktop app or install with your package manager.</p>
     <div class="actions"><a class="button primary" href="https://vibestudio.app/download/mac">Download for Mac</a><a class="button secondary" href="https://vibestudio.app/download/windows">Download for Windows</a></div>
     <p class="fine">Linux packages are <a href="#install-title">below</a>.</p>
   </section>
   <section aria-labelledby="desktop-title">
     <h2 class="section-title" id="desktop-title">macOS &amp; Windows</h2>
     <div class="grid">
       <article class="card">
         <div class="card-head"><div class="os-icon" aria-hidden="true">M</div><h2>macOS</h2></div>
         <p>Apple Silicon, macOS 14 or later. <a href="https://vibestudio.app/download/mac">Download the Mac DMG</a>, open it, and drag Vibestudio into Applications.</p>
         <p>The app isn’t notarized yet. If macOS blocks the first launch, choose Open Anyway in System Settings → Privacy &amp; Security.</p>
         <div class="step-label">Or install with Homebrew</div>
         <pre><code>brew install --cask panticonic/tap/vibestudio</code></pre>
       </article>
       <article class="card">
         <div class="card-head"><div class="os-icon" aria-hidden="true">W</div><h2>Windows</h2></div>
         <p><a href="https://vibestudio.app/download/windows">Download the Windows installer</a> and run the .exe. The x64 app also runs on Windows 11 ARM through emulation.</p>
         <p>The installer isn’t code-signed yet, so SmartScreen may warn. For the official Vibestudio installer, choose More info → Run anyway if offered.</p>
       </article>
     </div>
   </section>
   <section aria-labelledby="install-title">
     <h2 class="section-title" id="install-title">Linux package repositories</h2>
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
sudo dnf install Vibestudio</code></pre>
       </article>
     </div>
     <aside class="arch"><strong>Arch Linux</strong><p>Download the Arch package attached to the <a href="https://github.com/panticonic/vibestudio/releases">latest GitHub release</a>.</p></aside>
   </section>
 </main>
 <footer class="wrap"><a href="https://vibestudio.app/" data-carry-theme>Vibestudio</a><span>Questions or issues? <a href="https://github.com/panticonic/vibestudio/issues">Get help on GitHub</a></span></footer>
 </body>
</html>
HTML

log "repositories written to $OUTPUT_DIR"

# GitHub Pages permits at most 1 GB per published site.
# https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
site_bytes=$(find "$OUTPUT_DIR" -type f -printf '%s\n' | awk '{ total += $1 } END { printf "%.0f", total }')
if [ "$site_bytes" -gt 1000000000 ]; then
  log "site is $site_bytes bytes; exceeds GitHub Pages' 1 GB limit"
  exit 1
fi
log "site size: $site_bytes bytes"

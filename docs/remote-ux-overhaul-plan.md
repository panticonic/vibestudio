# Remote UX Overhaul — One-Shot Plan (deploy, pair, mobile)

**Status:** Planned, not started. This is a **single big-bang change set**: every
work package below lands together, none is optional, none is deferred, and no
feature flag gates any of it. When it merges, the old surfaces it replaces are
**deleted in the same change** — zero backward compatibility, zero migration
shims, zero legacy infrastructure left standing. Existing paired devices re-pair
once; that is the entire migration story (the same rule `webrtc-rpc-v2-plan.md`
set: "old links, wire formats, and half-built surfaces are deleted outright,
never shimmed").

**Audience:** a fresh agent with no prior context. Section 0 contains everything
you need to know about how the system works today and why each decision below
was made. Read it before touching code.

**Binding design rules** (inherited from `webrtc-rpc-transport.md` and
`webrtc-rpc-v2-plan.md`, still in force):

- Fail loud, never mask.
- One mechanism per job. Different topology is a different topology, not a
  fallback chain.
- One server RPC implementation; the server binds loopback only, forever.
- The **desktop's own connection** to its co-located server never touches
  WebRTC or signaling (loopback WS only). Serving WebRTC ingress to *other*
  devices is a server concern, not a client-transport concern: every server —
  including a desktop-spawned co-located one — runs WebRTC ingress by default.
  The server binary already supports exactly this posture — loopback bind plus
  WebRTC answerer — via the `pair-server.mjs` spawn path
  (`scripts/cli/lib/pair-server.mjs:11-14`); what does *not* exist yet is the
  wiring on the **desktop spawn path** (`LocalServerManager.spawnDetached`
  passes no signaling configuration to the child,
  `src/main/localServerManager.ts:194`) — WP1 adds it.
- Test the negative (every "refuses to X" claim gets a test).

---

## 0. Background: how the system works today, and why we are doing this

### 0.1 Topology

Vibestudio's server **always binds loopback** (`127.0.0.1`). There is no public
HTTP/TLS ingress; `--host` / `--public-url` / `--protocol` were removed and now
hard-error (`scripts/cli/lib/pair-server.mjs:44-46`). Every client — desktop
shell, mobile app, CLI — is a **paired device**:

- **Local co-located:** the desktop attaches to (or spawns) a detached
  OS-process server and talks loopback WebSocket
  (`src/main/localServerManager.ts`, `src/main/serverSession.ts:146-283`).
- **Remote:** any client reaches a server on another machine over a
  **fingerprint-pinned WebRTC pipe** (DTLS). The two ends rendezvous through a
  deliberately dumb Cloudflare signaling Worker (blind SDP/ICE relay + TURN
  cred vending, `apps/signaling/src/index.ts`), meeting in an unguessable
  per-invite room. Security lives entirely in the QR payload: the client pins
  the server's DTLS cert SHA-256 fail-closed before any token is sent.

The auth model is identical in both topologies — device pairing plus refresh
credentials — only the transport differs. Remote activation is gated on
`VIBESTUDIO_WEBRTC_SIGNAL_URL` being set (`src/server/index.ts:3593-3594`).

Pairing material is carried by a v=2 deep link (grammar in
`scripts/cli/lib/connect-utils.mjs:25-96`, mirrored byte-identically in
`packages/shared/src/connect.ts`, parity-tested):

```
vibestudio://connect?room=<id>&fp=<sha256>&code=<one-time>&sig=<wss-url>&v=2&ice=all|relay&srv=<label>
```

`room` is a fresh signaling room per invite; `code` is a one-time pairing code
redeemed over the WebRTC pipe itself for a durable device credential
(`deviceId` + `refreshToken`); `sig` is the signaling endpoint URL — the QR is
how clients learn where signaling lives; there is no discovery. The server
prints an ASCII QR of this link on startup (`printConnectBanner`,
`scripts/cli/lib/connect-utils.mjs:189-226`), which works over SSH.

All three remote clients bootstrap through **one shared implementation**,
`createPairedConnection` (`packages/rpc/src/transports/pairedConnection.ts`) —
desktop main via `src/main/webrtcServerClient.ts`, mobile via
`packages/mobile-webrtc/src/connect.ts:262`, CLI via `src/cli/webrtcClient.ts`.
This unification was the core deliverable of the v2 redesign and must be
preserved and extended, not forked.

A public/headless box runs a **hub** (`src/server/hubServer.ts`) that spawns
per-workspace child servers; the hub proxies invite-minting to the child over an
admin HTTP channel, and the child owns its own room and DTLS cert
(`hubServer.ts:224-262`). A hub-level WebRTC answerer that routes into children
was considered and **rejected** ("would re-introduce a parallel RPC ingress",
`webrtc-rpc-v2-plan.md:239,384-385`). This plan keeps that rejection.

### 0.2 The mobile app is two layers

Documented in `workspace/skills/appdev/MOBILE.md`:

1. **Native host shell** (`apps/mobile/`, bare React Native 0.79, Android +
   iOS projects, `react-native-webrtc`, Keychain, Firebase messaging). It owns
   first pairing, durable credentials, and fetching/verifying/activating the
   workspace app bundle. It is **server-agnostic**: nothing in the APK binds it
   to a particular server.
2. **Workspace app** (`workspace/apps/mobile/`), delivered **over-the-air from
   whichever server the phone is paired to** (streamed over the WebRTC pipe via
   `gateway.fetch`, integrity-verified, RN-reloaded; `apps/mobile/index.js`,
   `streamArtifactToNative` / `activateApprovedWorkspaceApp`).

Consequence that drives this whole plan: **"deploying the mobile app" to a
phone is two different problems.** Getting the shell APK on the phone is a
one-time, server-independent act. Everything after that — the actual app the
user sees — deploys itself from the paired server. So a phone paired to a
*remote* server gets its app *from the remote server* with no desktop
involvement at all.

The phone learns which server to pair with **only** from the QR/deep link it
scans (there is no in-app scanner today; the OS camera fires the
`vibestudio://connect` intent, `apps/mobile/index.js:668-716`).

### 0.3 Deploy is server-side everywhere

There is no client-side build-and-push. Source enters the workspace via the
`vcs.edit` RPC (`src/server/services/vcsService.ts:263-265`); the server builds
on demand (`src/server/services/buildService.ts`, `src/server/buildV2/builder.ts`)
into its own content-addressed store; clients stream built assets back
(remote: `src/main/panelAssetFacade.ts`). Deploying to a remote server is
therefore *the same RPC over a different pipe* — already true, nothing to build,
one caveat: remote panel **manifest** serving is an acknowledged follow-up
(`src/main/serverSession.ts:420-423`), which this plan closes (WP9).

### 0.4 What already works (do not rebuild these)

- SSH + QR pairing: `vibestudio remote serve` on a remote box prints a
  scannable QR in the terminal. This is the intended primary UX and it works.
- Desktop connecting to a remote server over WebRTC: fully wired, three-branch
  session establishment (fresh pair / returning device / local) in
  `src/main/serverSession.ts:122-151`, bootstrap chooser UI
  (`src/bootstrap/index.ts:535-579`), deep-link handler
  (`src/main/protocolHandler.ts`).
- Desktop minting invites **on its currently connected server** (local or
  remote) and rendering an on-screen QR:
  `workspace/apps/shell/components/PairedDevicesSection.tsx:48,86` calling
  `remoteCred.createPairingInvite` (`src/main/services/remoteCredService.ts:285-293`).
- Mobile connecting to a remote server via WebRTC: the same single code path as
  local; only the `sig` URL and `ice` policy differ.

### 0.5 Pain inventory (the reasons for every work package)

- **P1 — The signaling cliff.** There is no hosted signaling endpoint and no
  default anywhere in code; every user must create a Cloudflare account, run
  `wrangler deploy` in `apps/signaling/`, hand-copy the workers.dev URL into an
  env var on the server box (`docs/webrtc-deployment.md:25-38`). This is the
  single biggest onboarding cliff and makes every downstream flow feel
  developer-only. → WP1.
- **P2 — Remote install is fully manual.** `npm install -g` over SSH, export an
  env var, run in a foreground SSH session; nothing survives the session, no
  systemd unit, no docker, no automation of any kind exists in the repo. → WP3.
- **P3 — Silent degradation on identity half-state.** A crash mid-write can
  leave exactly one of the DTLS cert/key files; the server then boots
  **loopback-only with WebRTC ingress silently skipped**
  (`src/server/index.ts:3638-3645`, `webrtc-rpc-remediation-plan.md` item B9).
  On a headless box this presents as "my server vanished." Violates fail-loud.
  → WP2.
- **P4 — `node-datachannel` footgun.** If the native addon is missing, the
  symptom is that the pairing QR simply never prints
  (`scripts/dev-webrtc-remote.mjs:340-344`, `docs/webrtc-native-packaging.md:52-56`).
  → WP2.
- **P5 — Invite sharp edges.** `vibestudio remote invite` prints code + URL but
  **no QR** (`src/cli/client.ts:164-167`); an invite's `deepLink` can be `null`
  right after server startup and the client cannot reconstruct it
  (`src/cli/remoteClient.ts:251-255`); `auth.createPairingInvite` has no
  `returns` schema (`src/cli/remoteClient.ts:243-247`). → WP4.
- **P6 — Phone onboarding requires a dev toolchain.** The only way the CLI
  gets the shell APK on a phone is Gradle + adb (`scripts/cli/mobile-install.mjs`),
  Android-only. CI groundwork exists — `.github/workflows/build-mobile.yml`
  builds a release APK, signs it when `ANDROID_KEYSTORE_BASE64` is configured
  (**silently falling back to a debug-signed build when it isn't**), and
  uploads to GitHub Releases on `mobile-v*` tags — but nothing consumes it:
  `mobile install` never fetches the published artifact, there is no Play
  track, and no iOS tooling at all despite a checked-in `ios/` project. The
  well-known Worker for app-link association exists but is all TODO
  placeholders (`apps/well-known/config.json`). → WP6, WP7.
- **P7 — A QR-scan of `vibestudio://…` on a phone without the app does
  nothing useful.** Custom-scheme links have no not-installed story. → WP6.
- **P8 — Credential-store twins.** `src/main/services/localServerCredStore.ts`
  (`local-server-creds.json`) and `src/main/services/remoteCredStore.ts`
  (`webrtc-remote.json`) are parallel implementations of the same thing on the
  same `encryptedJsonStore` base, with parallel persistence call sites
  (`persistPairedCredential` vs `persistRotatedRemoteCredential`). → WP8.
- **P9 — The local loopback bootstrap is a second connect path.** Local WS
  connect + auth is inlined in `src/main/serverSession.ts:207-235` while the
  three remote clients share `createPairedConnection`; session shaping is
  likewise forked (local arm vs `buildRemoteSessionConnection`,
  `serverSession.ts:364-433`), and remote panel manifest serving is incomplete
  (`serverSession.ts:420-423`). → WP9.

### 0.6 Design conclusions (the reasoning, so you don't re-litigate it)

1. **Host a default signaling endpoint.** The signaling Worker is a blind relay
   by design ("Neither Worker sees your data", `docs/webrtc-deployment.md:21-24`);
   security lives in the fingerprint pin, not the Worker. Hosting one is
   therefore low-risk and removes P1 completely. Self-hosting stays a
   first-class configuration (it is configuration, not a legacy path).
2. **The desktop is a pairing broker, never a data relay.** Phones connect
   directly to the server. This is already the architecture (§0.4) and the
   hub-relay rejection (§0.1) stands. "Connect your phone from the desktop"
   means: mint an invite on the desktop's *current* server, show a QR. Nothing
   more is needed, which is why the headline feature is cheap.
3. **One payload grammar, two carriers.** The pairing payload stays v=2 and
   single-sourced. We add an **https carrier**
   (`https://vibestudio.app/pair#<params>`, payload in the URL fragment so it
   never reaches any server) that trampolines to the app when installed and
   shows install guidance when not. This is not a parallel grammar: one shared
   parser handles both carriers, and the carrier is presentation, not protocol.
   QRs encode the https carrier; machine-to-machine surfaces keep
   `vibestudio://connect`. The carrier reuses the **already-verified**
   `vibestudio.app` app-link host (Android App Link for OAuth callbacks,
   `apps/mobile/android/app/src/main/AndroidManifest.xml`; iOS
   `applinks:vibestudio.app`, `apps/mobile/ios/Vibestudio/Vibestudio.entitlements`)
   rather than standing up a second associated domain. Both platforms deliver
   the full URL *including the fragment* to the app (Android: the VIEW intent's
   data URI; iOS: `NSUserActivity.webpageURL`), and association matching is
   host/path-based so the fragment never affects link verification — but this
   is a load-bearing platform contract, so WP6 carries explicit
   fragment-survival acceptance tests on both platforms.
4. **Every server serves WebRTC ingress; the QR always works.** With hosted
   default signaling (WP1) there is no reason for any server — remote or
   desktop-spawned co-located — to boot without WebRTC ingress. This is what
   makes Path B a single story: "Connect a phone" mints a complete invite on
   whatever server the desktop is on, with no local/remote caveat, and the
   invite contract can be non-nullable (WP4).
5. **Unify what is accidental duplication; keep what is topology.** Two
   `ServerClient` transports (loopback WS vs WebRTC) are intentional and stay.
   Two credential stores and two client bootstraps are accidents of history and
   go. The unification of local connect into `createPairedConnection` abstracts
   *dial + auth + reopen*, not topology: the loopback transport plugin never
   touches signaling or WebRTC.
6. **No compatibility.** Pre-release, self-contained system. Old credential
   files are not migrated (devices re-pair once). Old docs sections are
   rewritten, not appended to. Anything replaced is deleted in this change set.

---

## 1. Target experience — the golden paths

These transcripts are the acceptance spec. Every command shown must exist and
behave exactly as shown when this plan lands.

### Path A — fresh remote box, one command from the laptop

```
$ vibestudio remote deploy user@myserver
✓ SSH connection            user@myserver (OpenSSH)
✓ Node.js 22.x found
✓ Installed @vibestudio/server 0.x.y
✓ Signaling                 wss://signal.vibestudio.app (hosted default)
✓ systemd user service      vibestudio-server.service (enabled, linger on)
✓ Server healthy            serverId 3f9c… · fingerprint A1:B2:…

  Scan to pair this device:            ▄▄▄▄▄▄▄ ▄  ▄ ▄▄▄▄▄▄▄
                                       █ ▄▄▄ █ ▀█▄  █ ▄▄▄ █   (ASCII QR)
  Pair URL: https://vibestudio.app/pair#v=2&room=…&fp=…&code=…&sig=…
```

The unit survives reboot and SSH disconnect. `vibestudio remote deploy` also
supports `status`, `update`, `logs`, and `remove` verbs against the same host.

### Path B — phone joins whatever server the desktop is on

Desktop (connected to *any* server, local or remote) → **Devices → Connect a
phone** → full-screen QR + one-line instructions. Phone scans with the OS
camera → https pair page opens the app (or shows the store/APK install page,
then re-fires the link) → confirmation sheet → paired **directly to the
desktop's current server** over WebRTC → workspace app streams OTA from that
server. Desktop shows the new device in the paired-devices list within seconds.

### Path C — desktop on a remote server, full parity

Desktop pairs to the remote server (existing chooser / deep link). After this
change, panels/manifests serve fully over the bridge (WP9) so the remote
session is indistinguishable from local, and every `vcs.edit`-driven deploy —
including mobile workspace-app updates — happens on the remote server. Phone
onboarding from this desktop (Path B) targets the remote server automatically.

### Path D — re-invite over SSH, any time

```
$ ssh user@myserver vibestudio remote invite
  (prints code, https pair URL, AND an ASCII QR — no server restart needed)
```

---

## 2. Work packages

All ten land in one change set. Ordering below is dependency order for
implementation, not staging.

### WP1 — Zero-config signaling

**Problem:** P1. **Outcome:** `remote serve` works with no signaling setup.

- Deploy the existing `apps/signaling` Worker to a canonical production
  account/route. Define the URL once as `DEFAULT_SIGNAL_URL` in
  `packages/shared/src/connect.ts` (single constant; the pair-page host in WP6
  lives beside it). Placeholder in this doc: `wss://signal.vibestudio.app` —
  fix the real domain at deploy time, then update the constant.
- Resolution order for the signaling URL, implemented in one shared resolver
  used by `remote serve`, `pair-server.mjs`, `mobile dev`, and the dev
  harnesses: `--signal-url` flag > `VIBESTUDIO_WEBRTC_SIGNAL_URL` env >
  `signaling.url` in the server config file > `DEFAULT_SIGNAL_URL`.
- **Delete** the refuse-to-start-without-signaling branch
  (`scripts/cli/lib/pair-server.mjs:419-431`) and the env-only activation gate
  semantics in `src/server/index.ts:3593-3594`: WebRTC ingress is now **on by
  default for every server** — `remote serve` *and* desktop-spawned co-located
  servers. A local server without ingress cannot host Path B ("Connect a
  phone"), so there is no ingress-less mode left to configure; the only
  remaining knob is *which* signaling endpoint (the resolver above). The
  desktop's own transport to its co-located server stays loopback WS (binding
  rule); ingress exists for the *other* devices.
- **Desktop spawn wiring (the missing piece):** the WP1 resolver runs in the
  Electron main process and `LocalServerManager.spawnDetached` passes the
  resolved signaling URL into the child's env alongside the existing
  `VIBESTUDIO_*` variables (`src/main/localServerManager.ts:194` area); the
  child's ingress state and pairing material then surface through the
  existing `server-ready.json` contract the same way `pairingCode` does
  today. Attach-to-existing validates ingress via `/healthz`-adjacent status
  so an attached server without ingress is treated like a version mismatch:
  stop + respawn.
- `vibestudio remote setup-signaling`: wraps `wrangler deploy` of
  `apps/signaling` (and optional TURN secret prompts) for self-hosters, then
  writes `signaling.url` into server config. Self-hosting is configuration,
  not a second code path: it feeds the same resolver.
- TURN: document that the hosted default ships with Cloudflare STUN only;
  `setup-signaling` prompts for TURN keys; `ice=relay` invites require TURN
  and `remote doctor` (WP2) verifies it.

**Acceptance:** on a clean box with no env vars, `vibestudio remote serve
--port 3030` prints a pairing QR whose `sig` is the hosted default; all four
resolution tiers are unit-tested; the old refusal path is gone and its test is
replaced by a "serves with default" test.

### WP2 — Identity and preflight hardening

**Problem:** P3, P4. **Outcome:** a headless box can never be silently
half-alive.

- **Single-file identity, atomically written.** A directory rename is not a
  valid atomic-replace story once a non-empty identity dir exists (rename onto
  a non-empty directory fails), and two files can never be replaced atomically
  together — so stop having two files. Consolidate the DTLS identity into
  **one file**, `<appRoot>/.vibestudio/webrtc/identity.pem` (cert + key
  concatenated, mode 0600): write to a temp name in the same directory,
  `fsync`, one `rename`. Half-state becomes **structurally impossible**, not
  merely unlikely. The old `server.{pem,key}` two-file layout is deleted
  (deletions register); existing installs mint a fresh identity and their
  devices re-pair once — which this change set already forces globally via
  WP8's credential reset, so it costs nothing extra.
- **Fail loud on any identity anomaly:** replace the catch-and-skip of
  `CertIdentityError` (`src/server/index.ts:3638-3645`) with startup
  **refusal** (non-zero exit) carrying exact remediation text — this now
  covers a corrupt/unparseable `identity.pem` and any remnant of the deleted
  two-file layout. Loopback-only "grace" boot is deleted; a paired remote box
  that cannot serve remote is down, not up.
- `vibestudio remote repair-identity`: inspects the identity file; offers
  exactly two actions — keep (if `identity.pem` parses cleanly) or regenerate
  with an explicit "all paired devices must re-pair" confirmation, clearing
  any legacy remnants. No silent re-mint, ever.
- `vibestudio remote doctor`: preflight suite run automatically by
  `remote serve` and `remote deploy`, and manually invocable. Checks:
  node-datachannel addon loads (P4 becomes an actionable error, not a missing
  QR), signaling endpoint reachable (`/healthz`), TURN creds vend if
  `ice=relay` configured, identity files coherent, systemd unit state (when
  present), clock skew. Every check has a one-line fix instruction.

**Acceptance:** deleting one of cert/key makes `remote serve` exit non-zero
with the repair message (negative test); `remote doctor` on a broken box
reports each induced failure; the addon-missing case prints the rebuild
command instead of hanging QR-less.

### WP3 — `vibestudio remote deploy` (SSH orchestration suite)

**Problem:** P2. **Outcome:** Path A transcript, verbatim.

New CLI family in `src/cli/` + `scripts/cli/remote-deploy.mjs`, pure SSH
orchestration (no agent on the box beyond the npm package itself):

- `remote deploy <user@host> [--port] [--signal-url] [--workspace <name>]`:
  probe SSH + node ≥20 (with install hint per distro if absent); `npm install
  -g @vibestudio/server@<exact version of the invoking CLI>` — **never
  `@latest`**: `@vibestudio/server` and `@vibestudio/app` are published
  independently per tag (`.github/workflows/release.yml`), so `@latest` on the
  box can outrun the operator's installed CLI and skew the wire protocol.
  Version convergence is operator-driven: `deploy update` moves the box to the
  (upgraded) CLI's version, and `remote doctor` reports server/client version
  and `hello` proto mismatch. An `--artifact <tarball>` flag installs an
  `npm pack`ed tarball (scp'd to the box, then `npm install -g ./<tarball>` —
  the same install mechanism with a different spec, not a second code path);
  this is how the CI smoke deploys the **working tree**, whose version is
  never on the registry (packages are staged by
  `scripts/build-npm-packages.mjs` and published only on tags,
  `.github/workflows/release.yml`). Then: write server config (port, signaling
  per WP1 resolver); install + enable a **systemd user unit**
  (`vibestudio-server.service`, `Restart=on-failure`) and enable lingering
  with an explicit **privilege ladder** — `loginctl enable-linger` frequently
  requires admin auth for SSH (non-seat) sessions under default polkit policy,
  so: try as the user; on denial retry `sudo -n loginctl enable-linger
  <user>`; if that also fails, **abort loudly** printing the exact one-line
  root command for the operator to run, and make `deploy` resumable so
  re-running after that command converges (idempotency already required
  below). `remote doctor` verifies linger state thereafter. Start the unit;
  poll readiness over SSH by reading the server's
  ready-file JSON (same contract as `applyReadyPayload`,
  `scripts/cli/lib/pair-server.mjs:207-231`); then run `remote invite` on the
  box and render the QR **locally** in the operator's terminal.
- `remote deploy status|logs|update|remove <user@host>`: unit status +
  `remote doctor` output; `journalctl --user -u vibestudio-server -f`; npm
  update + restart + health re-check; stop + disable + uninstall + optional
  state purge (prompted, destructive).
- Non-systemd hosts (e.g. macOS remote): fail with a clear "unsupported init
  system" error naming what was detected. One mechanism per job — no nohup
  fallback path.
- The unit file template and config schema live in the server package so
  `deploy update` can converge drift (rewrite unit + config every run;
  idempotent).

**Acceptance:** an end-to-end test against `localhost` sshd (CI container)
runs `deploy`, scans the emitted pair link with the CLI client
(`remote pair`), round-trips an RPC, then `deploy remove` leaves no unit, no
binary, no state. Re-running `deploy` twice is a no-op-converge (idempotency
test).

### WP4 — Invite overhaul

**Problem:** P5. **Outcome:** an invite is always a complete, QR-renderable
artifact, everywhere.

- **Server-side guarantee:** `auth.createPairingInvite` blocks (bounded, e.g.
  10 s) until WebRTC pairing material exists, then returns a **complete**
  invite `{deepLink, pairUrl, code, expiresAt, room, fp, sig, ice}`. With
  ingress always on (WP1) there is no legitimate ingress-less server left, so
  **delete the bare-code minting branch** in `mintPairingInvite`
  (`src/server/services/auth/model.ts` — the `room: null, deepLink: null`
  fallback that today serves "loopback co-located mode"). If pairing material
  cannot materialize within the bound, the RPC **errors** — it never
  half-succeeds.
- **Tighten the existing contract** (this is a replacement, not an addition —
  the `returns` schema already exists with nullable `deepLink`/`room`,
  `packages/shared/src/serviceSchemas/auth.ts:82`): make `deepLink` and `room`
  non-nullable `z.string()`, add `pairUrl`. Delete the client-side
  null-handling (`src/cli/remoteClient.ts:251-255`) and the hand-rolled shape
  validation together with its **stale comment** claiming no schema exists
  (`remoteClient.ts:243-247`) — the typed client validates via the schema.
- **Invite target resolution — `remote invite` must work on the server box
  itself with no prior pairing.** Today `remoteInvite` hard-requires stored
  CLI credentials (`loadCliCredentials()` → `AuthError("not paired")`,
  `src/cli/client.ts:147-148`), so `ssh box vibestudio remote invite` (Path D,
  and WP3's post-deploy QR) would fail on a box whose CLI never paired.
  Resolution order: **(1) co-located server** — if this machine hosts a
  running server (detected via the state-dir ready-file/config), mint the
  invite over a loopback admin channel authenticated by a 0600 state-dir
  admin token; possession of the OS account is already the trust root here
  (it is exactly how the ready-file `pairingCode` works today, and how the
  hub's admin channel mints child invites, `src/server/hubServer.ts:224-262`);
  **(2) stored CLI credential** — the existing paired-client path. No flag
  chooses between them; presence of a local server does.
- `vibestudio remote invite` prints the ASCII QR (reuse `printConnectBanner`'s
  QR path) plus code, https pair URL (WP6), and expiry — Path D verbatim.
- Hub parity: the hub's proxied invite path (`src/server/hubServer.ts:224-262`)
  returns the same complete shape; covered by the triangle e2e (WP10 test
  plan).

**Acceptance:** invite minted at t=0 immediately after server start is
complete (race test); schema-validated at the RPC layer; CLI/desktop/hub all
render QRs from the same invite object.

### WP5 — Desktop "Connect a device" flow

**Problem:** the crux ask; today's `PairedDevicesSection` is a settings
sub-widget, not an onboarding flow. **Outcome:** Path B, desktop side.

- Promote to a first-class **Devices** surface in the shell
  (`workspace/apps/shell/`): a "Connect a phone" action opens a modal with a
  large QR (https carrier, WP6), the human-readable pair URL, expiry countdown,
  and a live "waiting for device… → paired ✓ <device name>" status driven by
  the existing device-list RPC (`remoteCred.listDevices` polling or event).
- Works identically whether the desktop's current server is local or remote:
  it already calls the connected server's `createPairingInvite`, WP1
  guarantees even a desktop-spawned co-located server has WebRTC ingress for
  the phone to land on, and WP4 makes the invite complete by contract — so
  there is no local/remote caveat anywhere in this flow. The modal states
  which server the phone will join
  (`srv` label), so pairing a phone to the *remote* server while sitting at a
  desk is explicit, not surprising.
- Include first-run copy for the not-installed case: "No app yet? The QR link
  walks you through install." (backed by WP6's pair page).
- Keep `PairedDevicesSection`'s management duties (list, revoke) in the same
  surface; delete the old minimal invite rendering in favor of the new modal
  (one implementation).

**Acceptance:** Playwright-driven shell test — click Connect a phone, assert a
QR whose payload parses with the shared parser and whose `sig`/`fp` match the
connected server; simulated redemption flips the modal to "paired".

### WP6 — Pair-link https carrier + app-link infrastructure

**Problem:** P6 (partly), P7. **Outcome:** one payload grammar, two carriers;
scanning a QR on a bare phone leads somewhere useful.

- Add the https carrier to the **single shared grammar module**
  (`packages/shared/src/connect.ts` + its parity twin
  `scripts/cli/lib/connect-utils.mjs`; keep the byte-parity test):
  `https://vibestudio.app/pair#v=2&room=…&fp=…&code=…&sig=…&ice=…&srv=…`.
  Payload lives in the **fragment** — it is never sent to the pair-page host,
  so the hosted page learns nothing (consistent with the blind-signaling
  posture). `createConnectLink` gains a carrier parameter; `parseConnectLink`
  accepts both carriers and returns the identical payload object. v stays 2 —
  the payload is unchanged; carriers are presentation.
- **Carrier contract, made explicit:** both platforms hand the app the full
  URL *including the fragment* (Android App Link → VIEW intent data URI; iOS
  Universal Link → `NSUserActivity.webpageURL`), and app-link association /
  verification is host- and path-based, never fragment-based. This is
  load-bearing; the acceptance tests below prove fragment survival end-to-end
  rather than trusting platform documentation. Scanner apps or in-app browsers
  that bypass app-link handling fall through to the trampoline page — which is
  exactly its job.
- Build the **pair page** as a tiny static page served by the `apps/well-known`
  Worker at `https://vibestudio.app/pair`: reads the fragment client-side,
  deep-links into the app (`vibestudio://connect?…`), and on failure/timeout
  shows platform-detected install guidance (Play/APK link for Android,
  TestFlight/App Store for iOS per WP7) with a "retry open" button. No
  fragment ever leaves the page. Using the existing `vibestudio.app` host —
  not a new `pair.<domain>` — means the app-link association that already
  exists for OAuth callbacks extends to pairing instead of being duplicated.
- **Scheme-hijack hardening (the fallback is an attack surface, treat it as
  one).** Custom schemes are not exclusively bound to the official app —
  any Android app can register a `vibestudio://` intent-filter, and iOS
  cannot scope scheme registration (`apps/mobile/ios/Vibestudio/Info.plist`
  documents this for OAuth already) — and the fallback link carries the
  one-time pairing code. Hardening, in order of strength: the **verified App
  Link / Universal Link open is the primary, automatic path** and never
  round-trips through the scheme; on Android the page's fallback uses an
  `intent://…#Intent;package=app.vibestudio.mobile;…;end` URI, which pins
  delivery to the official package by ID — a hostile scheme registrant never
  sees it; on iOS (no package-pinning equivalent) the scheme fallback is
  **explicit-tap only** (never auto-fired) behind "Open in Vibestudio";
  containment for a won race: codes are one-time and short-TTL, redemption is
  visible immediately (WP5's modal flips to the paired device's name/platform,
  and every client surfaces a device-paired event) and one-tap revocable
  (`remoteCred.revokeDevice`). A hijack acceptance test (below) keeps this
  honest.
- **Complete and extend `apps/well-known`:** today the association is wired
  for OAuth callbacks only — the verified Android App Link intent-filter for
  `vibestudio.app` (`apps/mobile/android/app/src/main/AndroidManifest.xml:52`
  area) and `applinks:vibestudio.app` in
  `apps/mobile/ios/Vibestudio/Vibestudio.entitlements` exist for the OAuth
  path, while `assetlinks.json` / `apple-app-site-association` content is TODO
  placeholders (`apps/well-known/config.json`). Fill the association files
  (release-key SHA-256 fingerprints from WP7's signing setup; team ID + bundle
  ID), add the `/pair` path to the Android intent-filter's path patterns and
  to the AASA `components`/`paths` list alongside the OAuth path, and strip
  the `?mode=developer` associated-domains suffix on release builds (the
  entitlements TODO). Deploy the Worker on the `vibestudio.app` routes.
- QRs and human-facing surfaces (desktop modal, `remote serve` banner,
  `remote invite`) emit the https carrier; machine surfaces (`remote pair
  "<link>"`, adb deep-link in `mobile dev`, protocol handler) keep
  `vibestudio://connect`. Both feed one parser; there is no second grammar.
- Mobile native host: extend the existing verified `vibestudio.app`
  intent-filter / Universal Link entitlement to cover `/pair` alongside the
  existing `vibestudio://connect` scheme handler; both routes converge on the
  existing parse + confirmation + replay-guard path in the **native host**
  (`apps/mobile/index.js:668-748`; the workspace-app mirror in
  `workspace/apps/mobile/src/services/deepLinkConnect.ts` +
  `connectLinkReplayGuard.ts` handles the already-activated case).

**Acceptance:** parity test extended to the https carrier (create/parse
round-trip byte-identical across both modules); pair page e2e (Playwright):
fragment → app-open attempt → install guidance fallback; **fragment-survival
instrumented tests on both platforms** — Android: fire a verified App Link
VIEW intent for `https://vibestudio.app/pair#…` and assert the native host
receives the full fragment and reaches the confirmation sheet; iOS: deliver
the equivalent `NSUserActivity` in the simulator and assert `webpageURL`
round-trips the fragment into the same flow. **Hijack test:** install a decoy
app registering the `vibestudio://` scheme on the Android emulator and assert
(a) the App Link path never offers it, (b) the pair page's `intent://`
fallback launches only `app.vibestudio.mobile`, and (c) a redeemed invite is
immediately visible and revocable from the desktop Devices surface.

### WP7 — Mobile packaging: prebuilt shell, scanner, iOS

**Problem:** P6. **Outcome:** getting the shell on a phone requires zero dev
tools; iOS is a real platform, not a checked-in stub.

- **Harden the existing Android pipeline into a real release pipeline.**
  `.github/workflows/build-mobile.yml` already builds, conditionally
  release-signs, and uploads to GitHub Releases on `mobile-v*` tags — so this
  WP *finishes* it rather than creating it: provision the release keystore +
  Play App Signing for real; **delete the silent debug-signing fallback for
  tag builds** (a tag build without `ANDROID_KEYSTORE_BASE64` fails loud —
  fail loud, never mask); add an AAB build published to a Play
  internal/closed track alongside the GitHub-Releases APK; emit a checksums
  file with the artifacts. The signing fingerprints feed WP6's
  `assetlinks.json`. The OTA two-layer design (§0.2) means this APK rarely
  changes — it is deliberately boring.
- **`vibestudio mobile install` fetches the prebuilt release APK by default**
  (version-matched to the invoking CLI, checksum-verified against the release
  checksums file) and adb-installs it; the Gradle path becomes
  `mobile install --from-source` (contributor flow). If `adb` is missing,
  `mobile install` **auto-fetches Android platform-tools** into the vibestudio
  state directory and uses that copy — no SDK, no Gradle, no ANDROID_HOME, no
  pre-installed tooling of any kind. The toolchain download gets the same
  integrity contract as the APK: the platform-tools **version and per-OS
  SHA-256 are pinned in-repo**, the archive is verified against the pin
  before extraction, and a mismatch aborts loudly (an executable download
  with no integrity check is not a convenience, it's a supply-chain hole).
  Bumping platform-tools is a reviewed change to the pin, exactly like the
  workerd/esbuild prebuilt pins. The debug/internal build remains only
  inside `mobile dev` (it needs Metro). **Delete** the standalone
  `mobile build`/`apk` alias as a user-facing concept; it folds into
  `--from-source`.
- **In-app QR scanner — in the native host shell, where first pairing lives.**
  First pairing is owned by the native host (`apps/mobile/index.js:334,679-748`);
  the workspace app (`workspace/apps/mobile/`) only runs after a bundle has
  been activated, so a scanner in its `LoginScreen` could never serve a fresh
  install. Add `react-native-vision-camera` (or the current RN-community
  standard) to the **shell APK** with a scan screen in the native host's
  onboarding/unpaired state, feeding scanned links into the existing native
  parse + confirmation + replay-guard path. The workspace app's re-pair states
  (`workspace/apps/mobile/src/components/LoginScreen.tsx:37-39,102`) also get
  a "Scan QR" action backed by the same native module (it ships in the shell,
  so the OTA layer can use it). The OS-camera route continues to work.
- **iOS:** stand the `ios/` project up as a shipping target — CocoaPods lockfile
  in CI, `vibestudio mobile install --platform ios` (device/simulator via
  `xcodebuild`), Universal Link entitlement for the pair host, TestFlight
  publishing from CI on tagged releases, and the AASA side of WP6 filled with
  the real team/bundle IDs. Known limitation to document, not to fix here:
  WKWebView exposes no CDP, so brokered panel automation is unavailable on iOS
  (`apps/mobile/README.md:34-36`) — pairing, approvals, OTA workspace app, and
  panels themselves must all work.
- Firebase remains hand-provisioned per install for push
  (`apps/mobile/README.md:8-18`); wire the template-copy steps into
  `mobile doctor` output (new subcommand mirroring `remote doctor`) rather than
  leaving them doc-only.

**Acceptance:** CI produces installable signed artifacts for both platforms on
a tag, and a tag build without signing secrets **fails** (negative test);
`mobile install` on a machine with no Android SDK, no Gradle, no
ANDROID_HOME, and no pre-installed adb succeeds against a connected device
(platform-tools auto-fetch exercised; a USB-connected or networked adb device
is, necessarily, still required); scanner-initiated **first pairing** e2e on
the Android emulator from the native host's unpaired state (extend
`scripts/cli/mobile-smoke.mjs`); iOS simulator smoke: install, scan (paste
link), pair against a local answerer.

### WP8 — One credential store

**Problem:** P8. **Outcome:** one encrypted store, one persistence path, for
every paired server.

- New `src/main/services/deviceCredentialStore.ts` on the existing
  `encryptedJsonStore` base: file `device-credentials.json`, entries keyed by
  `serverId`, value `{deviceId, refreshToken, transport: "loopback"|"webrtc",
  pairing?: {room, fp, sig, ice, srv}, workspaceId, pairedAt, rotatedAt}`.
  Loopback entries have no `pairing` block; `workspaceId` is **required** on
  loopback entries and optional on webrtc entries (a remote pairing is
  server-scoped; workspace selection re-pairs into the workspace's room).
- **Keying, precisely** (today's local store is keyed by workspaceId —
  `localServerCredStore.ts:34` — and looked up by workspaceId at session and
  CDP-refresh time, `serverSession.ts:181`): primary key stays `serverId`
  because it is the one identity every flow ultimately authenticates against;
  the store exposes exactly two lookups, `byServerId(serverId)` and
  `byWorkspaceId(workspaceId)`. The second is total and unambiguous for
  loopback because each workspace spawns its own co-located server with its
  own `serverId` (the `data.json` `localServer` record maps workspace →
  serverId). One credential per server: re-pairing a server **replaces** its
  entry (there is no multi-credential-per-server case for a single desktop
  install; the server's device list is where multiple devices live).
- All call sites converge: `persistPairedCredential`
  (`localServerManager.ts:292-305`), `persistRotatedRemoteCredential` /
  `saveStoredRemote` (`serverSession.ts`), and `remoteCredService`'s
  reads/writes go through the one store.
- **Delete:** `localServerCredStore.ts`, `remoteCredStore.ts`, and both on-disk
  files (`local-server-creds.json`, `webrtc-remote.json`). **No migration** —
  on first launch after the change, the desktop simply has no stored
  credentials: local mode re-pairs automatically against the ready-file
  pairing code (invisible to the user); remote pairings are re-scanned once.
  Update `STATE_DIRECTORY.md` in the same commit.
- CLI: `~/.config/vibestudio/cli-credentials.json` already discriminates
  credential kinds (`src/cli/credentialStore.ts`); align its record shape with
  the desktop store's entry shape so the two serializations are the same type
  from `packages/shared` (one schema, two locations — desktop vs CLI is a real
  process boundary, not duplication).

**Acceptance:** grep-level: no references to the deleted stores/files remain;
unit tests for the unified store (rotation persistence, corrupt-tolerant load,
0600); e2e: local spawn re-pairs cleanly with an empty store; remote reconnect
uses the stored `pairing` block.

### WP9 — One connect path and full remote parity

**Problem:** P9. **Outcome:** every client reaches every server through
`createPairedConnection`; a remote desktop session is at feature parity with
local.

- **Loopback transport plugin:** extract the inline local WS bootstrap
  (`serverSession.ts:207-235`) into a transport provider for
  `createPairedConnection` (dial `ws://127.0.0.1:{port}/rpc`, present
  `pairingCode` or `refresh:` token, reuse the shared reopen/backoff/
  generation-fencing machinery). The plugin performs **no** signaling, no
  fingerprint pin (loopback has no DTLS identity), no WebRTC import — the
  "desktop's local transport never touches WebRTC" rule is enforced by
  construction and by a module-boundary test
  (`check-host-workspace-imports`-style).
- **Honest blast radius — the local path is more than dial + auth + reopen.**
  Around `createServerClient`, the local arm today also owns: detached-process
  supervision (`onConnectionStatusChanged: "connecting"` →
  `localServerManager.handleDisconnect()` probe/respawn), crash relaunch of
  the whole app, ready-file pairing-code acquisition, CDP shell-token refresh
  over loopback `POST /refresh-shell` on every reconnect, and credential
  persistence via `onPaired` (`serverSession.ts:146-240`). The unification
  keeps a strict split: **process lifecycle stays in `LocalServerManager`**
  (attach/spawn/healthz/supervise/stop is server *discovery and supervision*,
  not connection), and `createPairedConnection` grows the hook surface the
  local path needs — `onPaired`, connection-status callbacks that supervision
  subscribes to, and a per-transport `acquireCdpToken` capability (loopback:
  `/refresh-shell` HTTP; webrtc: over the RPC channel). Every one of those
  behaviors is enumerated in the migration checklist and covered by the
  existing local smoke before the inline code is deleted.
- **One session shaper:** merge the local arm of `establishServerSession` and
  `buildRemoteSessionConnection` (`serverSession.ts:364-433`) into a single
  `buildSessionConnection(transportKind, client)`; the remaining fork is data
  (asset origin, CDP token acquisition: loopback `/refresh-shell` vs RPC
  channel), expressed as per-transport capabilities on the plugin, not as two
  functions.
- **Finish remote panel/manifest serving** (the `serverSession.ts:420-423`
  follow-up): serve panel manifests and the full asset tree through
  `panelAssetFacade` (`gateway.fetch` streaming + content-addressed cache) so
  `wsInfo.path` semantics are identical local and remote. This is the parity
  Path C depends on.
- The two `ServerClient` implementations (`serverClient.ts` /
  `webrtcServerClient.ts`) remain, per §0.6(5) — but both are now thin
  adapters over the shared bootstrap; delete any residual per-impl
  reconnect/auth logic that the shared layer subsumes.

**Acceptance:** `serverSession.ts` contains one establishment flow
parameterized by transport; module-boundary test proves the loopback plugin
cannot import WebRTC/signaling modules; remote-session Playwright run opens a
panel whose manifest+assets came over the bridge; existing local smoke stays
green.

### WP10 — Documentation and registry sweep

Same change set, not a follow-up:

- Rewrite `docs/webrtc-deployment.md` around WP1–WP3 (hosted default first,
  self-host as configuration); rewrite the README install/remote sections
  around Paths A–D; regenerate `docs/cli.md` for the new/changed commands
  (`remote deploy|doctor|repair-identity|setup-signaling|invite`,
  `mobile install|doctor`); update `STATE_DIRECTORY.md` (WP8 files, systemd
  unit, server config file); update `workspace/skills/appdev/MOBILE.md` and
  `REMOTE_CLIENTS.md` for the scanner, https carrier, and prebuilt install.
- Mark the superseded sections of `webrtc-rpc-remediation-plan.md` (B9 identity
  handling) as closed by this plan.

---

## 3. CLI surface after this change

| Command | Behavior |
|---|---|
| `vibestudio remote serve` | Serves with hosted-default signaling (WP1 resolver); runs doctor preflight; prints https-carrier QR banner |
| `vibestudio remote deploy <user@host>` | Full Path A provisioning; `status` / `logs` / `update` / `remove` verbs |
| `vibestudio remote invite` | Complete invite + ASCII QR + https pair URL, no restart needed |
| `vibestudio remote doctor` | Preflight: addon, signaling, TURN, identity, unit, clock |
| `vibestudio remote repair-identity` | Restore-or-regenerate, explicit re-pair confirmation |
| `vibestudio remote setup-signaling` | Self-host wrapper for `apps/signaling`, writes config |
| `vibestudio remote pair/status/workspaces/select/logout` | Unchanged semantics; parse both link carriers |
| `vibestudio mobile install [--from-source] [--platform android\|ios]` | Prebuilt release artifact by default; Gradle/xcodebuild behind `--from-source` |
| `vibestudio mobile dev / smoke / logs / emulator / pair / doctor` | As today, plus `doctor` (Firebase/toolchain checks); `mobile build`/`apk` deleted |

## 4. State and config after this change

- `device-credentials.json` (desktop; replaces `local-server-creds.json` +
  `webrtc-remote.json` — both deleted, no migration).
- Server config file gains `signaling.url` (WP1) and is written by
  `remote deploy` / `setup-signaling`.
- `~/.config/systemd/user/vibestudio-server.service` on deployed hosts.
- DTLS identity written atomically; half-state is a startup **error**.

## 5. Deletions register (nothing on this list survives)

1. Refuse-without-signaling startup branch (`pair-server.mjs:419-431`) and the
   env-only WebRTC activation gate semantics (`src/server/index.ts:3593-3594`).
2. `CertIdentityError` catch-and-continue loopback-degrade
   (`src/server/index.ts:3638-3645`).
3. Client-side null-`deepLink` handling (`src/cli/remoteClient.ts:251-255`),
   the hand-rolled invite shape validation with its stale "no returns schema"
   comment (`remoteClient.ts:243-247`), the nullable `deepLink`/`room` in the
   `createPairingInvite` returns schema
   (`packages/shared/src/serviceSchemas/auth.ts:82`), and the bare-code
   `room: null` minting branch in `mintPairingInvite`
   (`src/server/services/auth/model.ts`).
4. QR-less `remote invite` output (`src/cli/client.ts:164-167`).
5. `localServerCredStore.ts`, `remoteCredStore.ts`, `local-server-creds.json`,
   `webrtc-remote.json`.
6. Inline loopback bootstrap (`serverSession.ts:207-235`) and the
   local/remote session-shaping fork (`buildRemoteSessionConnection` as a
   separate function).
7. `vibestudio mobile build` / `apk` as user-facing commands (folded into
   `install --from-source`).
8. The "remote panel serving is a follow-up" gap and its comment
   (`serverSession.ts:420-423`).
9. TODO placeholders in `apps/well-known/config.json` (replaced by real
   signing/team identifiers).
10. Old install/deployment docs sections superseded by WP10 rewrites.
11. The ingress-less server mode itself: the "loopback co-located mode" bare
    invite semantics and any startup path that brings a server up without
    WebRTC ingress (WP1 makes ingress unconditional; WP2 makes failure to
    establish it a startup error, not a degrade).
12. The silent debug-signing fallback for `mobile-v*` tag builds in
    `.github/workflows/build-mobile.yml` (unsigned tag releases become a CI
    failure).
13. The two-file DTLS identity layout `server.{pem,key}` and its half-state
    handling, replaced by single-file `identity.pem` (WP2).
14. The stored-credential prerequisite as the *only* path into
    `remote invite` (`src/cli/client.ts:147-148`) — superseded by invite
    target resolution (WP4): co-located loopback admin first, paired
    credential second.

## 6. Test plan

- **Unit:** signaling resolver tiers (WP1); invite completeness race (WP4);
  unified credential store rotation/corruption (WP8); link parity across both
  carriers and both grammar modules (WP6).
- **Negative (mandatory per design rules):** half-state identity → non-zero
  exit; invite when pairing material cannot materialize within the bound →
  RPC error (nothing nullable comes back, ever); `ws://` non-loopback `sig` →
  rejected; loopback plugin importing WebRTC modules → boundary check fails;
  `mobile-v*` tag build without signing secrets → CI failure; platform-tools
  archive failing its SHA-256 pin → abort before extraction; linger denied
  without usable sudo → `deploy` aborts printing the exact root command;
  decoy `vibestudio://` registrant never receives the pair payload (WP6
  hijack test).
- **Smokes (extend existing):** `desktop-pairing-smoke.mjs` via the unified
  bootstrap; `mobile-smoke.mjs` with scanner-initiated pairing; new
  `remote-deploy-smoke` against localhost sshd, installing the **working
  tree via `--artifact`** (npm-pack tarball — the tag version is never on the
  registry during CI) and exercising deploy → pair → RPC → remove, plus
  idempotent re-deploy and resume-after-linger-fix.
### 6.1 Full-system smoke — real emulator, real desktop automation (the headline)

One orchestrated harness, `scripts/full-system-smoke.mjs`, exercises **every
golden path end-to-end with the real clients**: the Android emulator running
the actual shell APK, and the branded Electron desktop driven by e2e
automation. It is built from the proven patterns already in the repo — do not
invent new machinery where these exist:

- **Desktop automation:** Playwright's `_electron` launch of the branded
  binary, exactly as `scripts/desktop-pairing-smoke.mjs` does today (single
  Electron launch handle for the whole flow, deep-link launch argument,
  screenshots to `test-results/`, crash-proof cleanup that always SIGKILLs
  Electron + children on pass or fail). UI steps are driven through Playwright
  selectors against the shell; pairing payloads are read from the modal's DOM
  (the QR's link is also rendered as text) — never by decoding QR pixels.
- **Mobile automation:** the Android emulator machinery from
  `scripts/cli/mobile-dev.mjs` (AVD boot, `adb reverse`, deep-link injection
  via `adb shell am start`) plus the `smokePhase` logcat markers that
  `scripts/cli/mobile-smoke.mjs` already asserts on
  (`apps/mobile/index.js` emits `embedded-pairing-start/-complete`, bundle
  activation phases). The APK under test is the release artifact in CI
  (`--from-source` locally).
- **"Remote" box:** a local container with sshd (CI: the job's service
  container), provisioned by the real `remote deploy --artifact` path — the
  smoke tests the deploy tool, not a hand-rolled substitute.
- **Signaling:** `wrangler dev apps/signaling`, as in every existing smoke.

**Phases, in order — each phase emits a named marker and hard-fails the run:**

1. **Deploy (Path A):** `remote deploy --artifact <packed working tree>` into
   the container; assert systemd user unit active, `remote doctor` green, and
   a complete pair link emitted; parse it with the shared grammar module.
2. **Desktop → remote (Path C):** launch Electron with the pair deep link;
   assert WebRTC session connected, then open a panel and assert its
   manifest **and** assets arrived over the bridge (WP9 parity); screenshot.
3. **Phone ← desktop, remote server (Path B):** via Playwright, open
   Devices → "Connect a phone"; pull the invite link from the modal DOM; fire
   it into the emulator as a **verified App Link VIEW intent** (the https
   carrier, proving fragment survival in passing); drive the native host's
   confirmation sheet via adb/uiautomator; assert logcat `smokePhase` pairing
   markers, OTA workspace-app fetch/verify/activate markers, and the desktop
   modal flipping to the paired device's name. Then **revoke from the desktop
   UI** and assert the phone lands on its re-pair screen.
4. **Invite over SSH (Path D):** `ssh <container> vibestudio remote invite`
   with **no CLI credentials in the container** (proving the WP4 loopback
   admin path); redeem the printed link with the CLI client; RPC round-trip.
5. **Local-server variant (the P0 proof):** relaunch Electron against a
   locally spawned co-located server (default ingress per WP1); repeat phase
   3 against it, with the emulator reaching loopback signaling via
   `adb reverse` exactly as `mobile dev` wires it today.
6. **Hub-mode variant:** repeat phases 1–4 with the container running the hub
   (`src/server/hubServer.ts`) so proxied child-server invites are covered.

**Forensics on failure (mandatory, not best-effort):** the harness always
collects desktop screenshots + the Electron main log, full `adb logcat`, the
container's `journalctl --user -u vibestudio-server`, and the wrangler dev
log into `test-results/full-system-smoke/` before cleanup.

**Invocation and CI wiring:** `pnpm smoke:full` runs the whole ladder
locally. In CI it extends `.github/workflows/webrtc-e2e-nightly.yml` (the
emulator job uses the standard Android-emulator runner action with KVM) and
**must also run on-demand for the overhaul change set itself** — the
definition of done (§7) requires it green, so it cannot live only in a
nightly. Phases are independent enough to report individually but the job is
one run: the point of this harness is the *composition*.

- **iOS:** simulator install + paste-link pairing smoke in CI, asserting the
  same `smokePhase` ladder through pairing and OTA activation
  (device/TestFlight verified manually per release; CDP-brokered panel
  automation is unavailable on iOS, so panel assertions are Android-only).

## 7. Definition of done

- All four golden-path transcripts (§1) reproduce verbatim on clean machines.
- Deletions register (§5) fully executed; CI greps prove no references remain.
- All tests in §6 green in CI — including a full pass of the §6.1
  full-system smoke (`pnpm smoke:full`: emulator + Playwright-driven desktop,
  all six phases) on the change set itself, not just nightly; both mobile
  release artifacts produced on tag.
- Docs sweep (WP10) merged in the same change set.
- No feature flags, no compatibility branches, no "TODO(follow-up)" markers
  introduced by this change.

## 8. Known hazards (handle, don't defer)

- **Hosted-infra coupling:** the default signaling endpoint becomes production
  infrastructure; its outage degrades *new pairings and reconnect rendezvous*
  for default-config users. Mitigate inside this change: `remote doctor`
  distinguishes "your server is fine, signaling is down"; self-host path is
  first-class; the Worker is stateless-per-room and trivially redeployable.
- **Re-pair-once fallout:** WP8 logs a single clear "credentials reset —
  re-pair" line on first post-upgrade launch; local mode re-pairs invisibly.
- **App-store/gatekeeping externalities (WP7):** Play/Apple review timelines
  are outside CI control; the GitHub-Releases APK and TestFlight keep the
  install path real even while store listings are pending. These are release
  logistics, not gated features — the pipelines land now.
- **`remote deploy` host diversity:** systemd-user-only by design; the error
  for anything else is explicit. Do not grow a second daemonization mechanism.
- **Version skew between operator CLI and deployed server:** eliminated by
  construction — `remote deploy`/`update` pin the box to the invoking CLI's
  exact version (never `@latest`), and `remote doctor` surfaces version and
  `hello` proto mismatch when an operator mixes machines anyway.
- **Fragment-carrier platform contract:** both mobile platforms deliver the
  URL fragment with app-link launches, but this plan does not take that on
  faith — WP6's fragment-survival instrumented tests are release-blocking. If
  a specific scanner/browser path drops app-link handling entirely, the
  trampoline page is the designed catch-all, not a fallback code path.
- **Reviewer note on big-bang scope, considered and rejected:** a review pass
  flagged the single-merge delivery of hosted infra + SSH deploy + invite
  contract + desktop UI + app-link infra + mobile pipelines + credential and
  session refactors as operationally brittle. That breadth is a deliberate,
  binding requirement of this plan (see the header): no gating, no deferral,
  no optionality. The mitigations are the ones already in this document —
  golden-path transcripts as the acceptance spec, mandatory negative tests,
  and the deletions register executed in the same change set — not staging.

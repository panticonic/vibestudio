# Mobile Asset Plane & Startup Plan

Status: implementation record · 2026-08-10 (rev. 5.3 — durability, one origin
contract, resumable startup, and automated recovery smoke implemented; Phase E
remains an explicitly measured follow-up decision)

Scope: the mobile client's panel-code delivery path, its cache tiers, its startup
sequence, and its resume/recovery behaviour. This plan supersedes an earlier
model-generated review of "mobile is slow"; that review is reproduced in
condensed form in §2 with every claim re-verified against the source, and its
errors corrected. §2.4 records a second review of *this document* and what it
changed; §2.5 records the first physical-device evidence; §2.6 and §2.7 record
the third and fourth reviews. It is a sibling of
`docs/performance-optimization-plan.md` (server startup, bundle composition)
and completes `docs/webrtc-rpc-v2-plan.md` §6
("Asset plane"), whose mobile half was never built as specified.

The asset-byte cost model in §3 is still static arithmetic, not a profile.
However, rev. 3 is no longer wholly unmeasured: §2.5 contains observations from
an instrumented physical Pixel 9a run through the deployed signaling service
and a managed server bootstrap. They are diagnostic samples, not a baseline;
Phase 0 still gates optimisation work and must turn them into repeatable traces.

---

## 0. Ambition

The narrow reading of "panels load slowly on mobile" produces a tuning exercise:
fewer socket writes, a bigger cache, a shorter startup chain. That reading is
available, it is worth a few days, and it is **not what this plan is.**

The wider reading is that the mobile client is currently a *thin* client that
happens to hold a WebView: it owns no durable copy of anything, so every
lifecycle event — background, resume, reconnect, relaunch — returns it to zero
and it re-derives the entire world over a phone-grade link, through a JavaScript
interpreter, one 16 KiB base64 string at a time. The slowness is a symptom. The
design gap is that **immutable application code is being treated as live RPC
data.**

The target, and the thing this plan commits to:

> **Panel code is stored, not re-fetched.** The device holds a durable,
> content-addressed artifact store on real disk. Opening a panel whose code it
> has already seen — after a background, a resume, a reconnect, or a relaunch —
> costs **zero pipe bytes and no multi-megabyte traffic through Hermes**. The
> panel loopback origin serves immutable content and nothing else, on both
> platforms. The pipe carries live RPC.

*Scope, deliberately cut (rev. 5).* Earlier revisions committed to more than the
evidence supports and more than the problem requires. Three things are struck:

- **Background prefetch is punted.** It was the reason for the entire manifest
  protocol stack — dual representation identities, an artifact-manifest RPC, a
  representation-addressed retrieval method, a build-store derivative service,
  cross-platform route canonicalization, and verify-then-serve. None of that is
  needed to make a warm open free; all of it was needed to make a *first* open
  free. That is a much smaller prize for a much larger contract.
- **Offline rendering is struck as a goal.** It was never asked for, and it buys
  a capability by adding a second, non-authoritative runtime contract.
- **The native loopback server is struck.** The JS server stays; the durable
  store goes behind it. See Phase C for why the remainder is not worth two
  hand-rolled HTTP implementations.

*Not* struck: Phase E, the inbound base64 hop on a **cold** open. It was briefly
cut with the rest and has been restored, because everything above only fixes the
warm path — and because a phase whose status is "gated" quietly becomes a phase
that never happens. It is now a question with a required answer and a
pre-registered threshold. See Phase E.

What survives is the part that was always load-bearing: durability, one origin
contract, and deleting the self-inflicted cache defeats.

Everything below is either (a) verification that the diagnosis is real, or
(b) the path to that sentence.

---

## 1. The one-paragraph diagnosis

Multi-megabyte immutable application code is pulled over the WebRTC pipe on
every cold load, reassembled in Hermes, copied twice, re-framed as HTTP, and
pushed back out through a JavaScript TCP server — crossing the React Native
bridge **base64-encoded in both directions** at 16 KiB granularity. Meanwhile
the three things that would make the second load free are each defeated: the
WebView's HTTP cache is explicitly disabled for exactly the managed panels that
need it, the façade's only cache is memory-resident and is cleared every time
the app backgrounds, and the on-disk content-addressed cache that the v2 plan
specified for mobile was never built. So normal phone usage — open, use, switch
away, come back — reliably produces a cold, maximally expensive load, and that
load runs on the same JS thread as every RPC response, event, and React render,
so *everything* degrades together.

---

## 2. Reviews of record

### 2.1 The originating review — confirmed

A static read that prompted this plan. Its central instinct was right and its
primary finding is real.

| # | Claim | Verified at |
| --- | --- | --- |
| C1 | Managed panels disable the WebView HTTP cache | `workspace/apps/mobile/src/components/PanelWebView.tsx:1178` — `cacheEnabled={!managed}`, `cacheMode={managed ? "LOAD_NO_CACHE" : "LOAD_DEFAULT"}` |
| C2 | The façade's only cache is memory-resident | `workspace/apps/mobile/src/services/panelAssetFacade.ts:125` (`MobileAssetMemoryCache`), 256 MiB LRU, no persistence |
| C3 | It is cleared on every background transition | `workspace/apps/mobile/src/hooks/useAppLifecycle.ts:72` → `shellClient.trimMemory()` → `facade.trimCache()` (`shellClient.ts:1131`) |
| C4 | Every cold asset traverses WebRTC → JS → JS-TCP → WebView | `panelAssetFacade.ts:406-429`, `540-578` |
| C5 | 16 KiB is a hard data-channel cap | `packages/rpc/src/transports/webrtcPeer.ts:183` — `DEFAULT_CHUNK_SIZE = 16 * 1024`, because react-native-webrtc corrupts larger messages |
| C6 | Three awaited socket writes per received chunk | `panelAssetFacade.ts:568-570`, each awaiting a native callback via `writeToSocket` (`:631`) |
| C7 | Panel RPC is a lazy multi-hop relay; the first call pays grant + session setup | `bridgeAdapter.ts:216`, `mobileTransport.ts:218` |
| C8 | Streaming panel RPC is 256 KiB base64 chunks with a per-chunk ack | `packages/rpc/src/bridgeStream.ts:311-325` — "ONE chunk in flight", `await acked` |
| C9 | Startup is a serial RPC pipeline | `shellClient.ts:962` → `connectWorkspace` → `startPanelAssetFacade` → `ensureReactNativeHostTargetReady` → `initPanels` |
| C10 | The runtime-lease snapshot is fetched twice at startup | `shellClient.ts:298` and again at `:1116` |
| C11 | The two mobile pipes are established sequentially | `packages/mobile-webrtc/src/connect.ts:383-390` |
| C12 | Bundle activation never consults the already-active bundle | `activeBundlePathIfMatches` (`VibestudioBundleStore.kt:30`) has **zero call sites**; `activateApprovedWorkspaceApp` (`bundleDelivery.ts:308`) always re-streams |
| C13 | Cold launch reads and hashes the entire bundle | `VibestudioBundleStore.kt:14-28`, `ios/Vibestudio/AppDelegate.mm:97` |
| C14 | Materialization serializes panel-init → lease → URL | `workspace/apps/mobile/src/services/panelMaterializer.ts:86-110` |

### 2.2 The originating review — corrected

**X1 — The dominant per-byte cost is double base64 across the RN bridge, not the
three socket writes.**

- **Inbound.** `react-native-webrtc` base64-encodes every binary data-channel
  message natively and decodes it in JavaScript:
  `node_modules/react-native-webrtc/src/RTCDataChannel.ts:160` —
  `base64.toByteArray(ev.data).buffer`, via the pure-JS `base64-js` package.
- **Outbound.** `react-native-tcp-socket` does the reverse: `src/Socket.js:367` —
  `NativeModules.TcpSockets.write(id, generatedBuffer.toString('base64'), msgId)`,
  decoded natively at `TcpSocketModule.java:132`.

Our own wire format is binary and zero-copy (`packages/rpc/src/protocol/bulkMux.ts`
returns payloads as views past the header); the encoding tax is imposed entirely
by those two React Native libraries, at the two points this plan has to
eliminate.

**X2 — The 16 KiB granularity cannot be widened.** DATA frames never accumulate
in the demux (`bulkMux.ts` `createBulkDemux`: only HEAD/ERROR continuations
accumulate), so each 16 KiB wire message becomes exactly one `reader.read()`.
The cap (C5) is a correctness constraint, not a tuning knob.

**X3 — "Mobile has NO filesystem dependency" is false.**
`panelAssetFacade.ts:22` justifies the memory-only cache with that claim. The
native module already writes multi-MB files to disk on both platforms
(`VibestudioMobileHostModule.kt:77,106`; `ios/Vibestudio/VibestudioMobileHost.mm:49,89`).
`docs/webrtc-rpc-v2-plan.md:390` specified an on-disk content-addressed cache for
*both* façades ("mobile: RN file storage"), and the desktop half exists and is
tested (`src/node/panelAssets/assetDiskCache.ts`). The mobile memory cache is an
**unrecorded deviation from an approved design**, not a platform constraint.
This is the most important correction in the document: it moves the ambitious
end state from speculative to overdue.

**X4 — Making the hub-control pipe lazy is the wrong fix; parallelise instead.**
Hub control backs approvals, workspace switching, device management and push;
laziness trades a measured startup cost for an unmeasured interaction stall and
adds a "control pipe not up yet" failure mode to every call site. See §2.4 R4 for
why parallelising is safe under the actual credential contract.

**X5 — The 4 s ICE wait is not a flat 4 s per peer.**
`reactNativeWebRtcPeer.ts:623` polls every 100 ms and returns on the *first*
local candidate, including candidates recovered from `getStats()`. The full 4 s
is paid only when gathering genuinely yields nothing. Still a clock-bound
workaround to a lifecycle-shaped problem, but not a routine 8 s tax.

**X6 — The resume storm has three refresh owners, not two.**

1. `useAppLifecycle.ts:56` — foreground → `panels.refresh()`.
2. `shellClient.ts:1151` — `registerResubscribeHandler("mobile-panel-tree")` →
   `panels.refresh()`.
3. `MainScreen.tsx:938` — `transport.onReconnect(...)` → `panels.refresh()`; and
   `onReconnect` is just `onRecovery("resubscribe", …)` (`mobileTransport.ts:268`),
   i.e. the *same signal* as (2).

Plus a fourth effect the review missed: `MainScreen.tsx:325` —
`onRecoveryComplete` **reloads every managed WebView**. With the WebView cache
disabled (C1) and the memory LRU just cleared (C3), that reload guarantees a full
cold re-pull of every resident panel's code, on the JS thread, concurrently with
three tree refreshes.

**X7 — Bundle re-download frequency.** C12 is real, but
`activateApprovedWorkspaceApp` runs on activation events (pairing, host-target
change, reset), not every cold launch.

### 2.3 The originating review — missed

**N1 — No HTTP keep-alive.** One request per connection
(`panelAssetFacade.ts:296-359`), every response `Connection: close` (`:507`).

**N2 — The cache tee doubles JS-side copy cost for the cacheable assets.**
`tee()` (`:163`) + `streamToUint8Array` (`:580`) + a concatenating copy (`:604`).

**N3 — The mobile cache key is not a content address.** `panelAssetCacheKey`
keys on URL path + forwarded headers (`:234`); `normalizeResult` **discards**
`x-vibestudio-content-digest` (`:472`).

**N4 — No fairness between concurrent panel loads.** Becomes load-bearing once
background prefetch exists — prefetch must never outrank a visible load.

**N5 — `ensureReactNativeHostTargetReady` sits on the critical path of every
workspace init** (`shellClient.ts:967`), including a 1 s poll loop (`:1103`),
before the connected client is published to the UI.

**N6 — Panel session lifetime vs. lease lifetime is unmodelled.** The grant is
one-shot and refetched on every (re)open (`mobileTransport.ts:218`).

**N7 — There is no artifact manifest surface.** `build.getBuild`
(`packages/service-schemas/src/build.ts:579`) returns artifacts **with content
inline** (`buildArtifactSchema:108`). There is no way to ask "what does build X
consist of?" without transferring the whole build.

### 2.4 Review of this document (rev. 1 → rev. 2)

A second review examined rev. 1. Six of its seven major points and all five of
its corrections were verified valid and are folded in below. One was verified
wrong and is recorded here so it is not re-litigated.

| Ref | Point | Verdict | Where it landed |
| --- | --- | --- | --- |
| R1 | The manifest's `integrity` is the *uncompressed* identity, but the store keys by the *received (gzip)* representation, so reconciliation can never hit | **Valid** — `artifactIntegrity` hashes decoded content (`src/server/buildV2/buildStore.ts:405`); the gateway deliberately emits no digest header (`src/server/services/gatewayFetchService.ts:31-42`) | Phase B: dual-identity manifest contract |
| R1b | "A metadata manifest alone provides no mechanism to pull a missing digest" | **Overstated** — `gateway.fetch` already supports `Range` + `RESUMABLE_GZIP_HEADER` (`gatewayFetchService.ts:288-296`), used today by `bundleDelivery`. What is missing is path→representation binding, verification-on-receipt, and priority — not a transfer surface | Phase B/C |
| R2 | Phase D cannot deliver offline opening: the entry document is `no-store`, and materialization needs live `getPanelInit` + lease | **Valid** — `panelMaterializer.ts:63`; and a lease is live authority, not offline data | Phase B (immutable entry doc) + Phase D (launch descriptor) |
| R3 | "Native server, JS policy table" is split ownership: two request paths, unspecified invalidation, sync-native-waiting-on-async-JS, stale authorization | **Valid** | Phases B–D collapsed into a manifest-first design; the authorization table is deleted |
| R4 | Concurrent pipe establishment is unsafe under the credential-rotation contract | **Wrong — see below** | X4 stands; rebuttal recorded |
| R5 | Concurrent panel-init + lease can acquire a lease for a retired entity | **Valid**, though "retain the present ordering" is too strong — the managed-pending-`buildKey` branch already leases on the tree id without calling `getPanelInit` (`panelMaterializer.ts:70-85`) | Downgraded; requires atomic op or compensating release |
| R6 | Large panel RPC bodies must not use the asset origin | **Valid** — the origin is unauthenticated and must never *address* management routes (`gatewayFetchService.ts:242`) | Option (b) deleted |
| R7 | Phase E's silent fallback contradicts fail-loud and keeps two bulk paths forever | **Valid** | Phase E: negotiated capability, fail visibly |
| R8 | S4 ("zero bytes through Hermes") is in the wrong phase while the entry document still flows through JS | **Valid** | S4 moved to Phase C, gated on Phase B's immutable entry document |
| R9 | Index/authorization state needs workspace + build partitioning, not just server identity | **Valid** | Phase C storage model |
| R10 | "Durable" cannot live in an OS-purgeable cache directory if offline is promised | **Valid** | Phase C storage model |
| R11 | Path + size + file identity is not tamper-evident (same-size in-place modification) | **Valid** — the word was wrong | Bundle delivery §6.7 |
| R12 | Phase A's JS keep-alive parser is throwaway complexity Phase C deletes | **Valid** | Dropped from Phase A |

**R4 — rebuttal.** The claim is that reconnect is *intentionally* sequential
because the control pipe may rotate and persist the refresh credential before the
workspace pipe uses it. The server does not work that way:

- `validateRefresh` **does not rotate** — it validates the presented hash and
  stamps `lastUsedAt` (`src/server/hostCore/deviceAuthStore.ts:220-240`).
- `onPaired` fires **"once when the main session paired a fresh device (redeemed
  the QR code)"** (`packages/rpc/src/transports/pairedConnection.ts:87`), i.e. on
  first pairing, not on reconnect.
- The desktop remote client **already dials both pipes concurrently**, with the
  rationale in a comment: *"Both pipes authenticate with the SAME stable refresh
  credential (validateRefresh does not rotate; onPaired fires only on fresh
  pairing), so the control and workspace dials are independent and run
  concurrently"* — `src/main/serverSession.ts:437-446`, `Promise.allSettled`.

The review read mobile's defensive `currentStored` threading
(`connect.ts:373-390`) as a protocol requirement. It is not; **mobile is the
outlier**, and this is another instance of the desktop/mobile divergence class
that produced X3. No protocol change is required. One piece of cheap insurance is
adopted anyway: credential persistence goes behind a **single serialized
writer**, so that if `onPaired` ever does fire on two reaches at once it cannot
last-writer-wins. The concurrency applies to the *reconnect* path only; first
pairing, where `onPaired` genuinely fires, keeps its present ordering.

### 2.5 Physical-device review (rev. 2 → rev. 3)

A Pixel 9a was installed and driven over USB while the real server and deployed
signaling service were observed. These are single-run facts, preserved here so
the plan does not collapse distinct waits into "WebRTC is slow":

The retained follow-up run IDs, bounded transfer observations, build high-water
samples, and process cleanup proof are recorded in
`docs/measurements/mobile-physical-baseline-2026-08-10.md`. The table below also
contains earlier diagnostic samples that predate retained system-test artifacts.

| Observation | What it establishes | What it does **not** establish |
| --- | --- | --- |
| A live room produced an offer at 08:00:42.965 and an answer at 08:00:47.439; ICE selected a direct host path and the authenticated server pipe came up | The exercised phone/server pair can establish a direct pipe; offer → answer was about 4.5 s in this sample | That ICE or bulk throughput is the 4.5 s cause. The interval still contains signaling delivery and answerer work and needs phase markers |
| A saved room with no live answerer emitted an offer and candidates, then surfaced `peer unreachable (no signal observed)` at the 30 s connect ceiling | The client correctly distinguished "no signal observed" from a signaling-service failure | That 30 s is useful detection. It is a terminal availability case currently discovered by a generic clock |
| After the authenticated control pipe came up, the phone remained on "Pairing … Preparing secure workspace access" for the full 240 s smoke ceiling | Pairing completion is blocked by workspace preparation, not by the established WebRTC pipe | That pairing itself failed or that increasing a transport timeout would help |
| The blocking chain was `completeFreshMobilePairing` → `hubControl.routeWorkspace` → `ensureWorkspaceRuntime`; all workspace services had started, but the child had not published the single late readiness record | The bootstrap contract has only one readiness threshold, and it is too deep for routing/pairing UX | That workspace preparation can be skipped. It must become a later explicit lifecycle state |
| An idle managed instance, after declaring itself ready, speculatively compiled all 40 panel/worker units: roughly 1.0 GiB workspace Node RSS, 767 MiB esbuild RSS, and hundreds of MiB of workerd RSS were observed, alongside large dependency/cache growth | Post-ready workspace-wide prewarm is a real crash-class resource consumer and is not idle work | A stable per-process budget; Phase 0 must sample high-water RSS over time and across cold/warm runs |
| Removing `prewarmWorkspaceBuilds()` eliminated that post-ready compile in the next doctor run; no `npm install` remained after settling, workerd was about 229 MiB, and the build cache was 108 MiB rather than 363 MiB | Lazy runtime-unit compilation is the correct present default and materially reduces idle pressure | That the remaining bootstrap is cheap; explicitly activated extensions still install/build and need their own accounting |
| The exact mobile system test reported pass although no Electron provider existed, no provisioning call ran, and the agent's final text said it could not start provisioning | Completion-report validation can certify a trajectory that never exercised the product | Anything about product correctness. Provider presence and structured harness outcomes must gate the test before semantic reporting is considered |

Three design corrections follow.

**R13 — Pairing, routing, and workspace readiness are different commits.** A
durable device pairing is an identity/control-plane result. Routing needs a
child ingress that can authenticate and accept a workspace pipe. First paint
needs a smaller shell-ready set. Full extension reconciliation, dependency
installation, and speculative builds are later work. One late `ready` record
currently conflates all four. The fix is an explicit monotonic readiness
lifecycle (§6.5), not an optimistic response or a second route.

**R14 — A stale room is an availability problem, not a slow transport.** The
30 s ceiling remains as a final safety bound, but an offer addressed to a room
without an active answerer should resolve from answerer presence/lease state.
The signaling room is already the one rendezvous surface; making its peer
lifecycle explicit does not create a fallback channel. This work belongs with
the existing signaling-supervision design in
`docs/webrtc-rpc-remediation-plan.md`, not in asset-transfer tuning.

**R15 — Speculation is subject to the same priority rule as network prefetch.**
Compiling every panel/worker after publishing ready violated P8 locally: it
consumed crash-class memory before user intent. The eager call has been removed
in the current checkout. It must not be restored merely because the work is
labelled "post-ready". This overrides the unconditional restoration proposed by
`docs/authority-baseline-cold-cost-plan.md` W4: any future prewarm must be
bounded, cancellable, memory-budgeted, and justified by Phase 0 evidence, or be
replaced by manifest-level indexing as that plan's W5 proposes.

---

### 2.6 Third review (rev. 2 → rev. 3)

A third review examined rev. 2's asset-plane sections. Every code-level claim was
re-verified; **all of it held**. Refinements and one flipped recommendation
follow. Numbered R16+ to avoid colliding with the startup review's R13–R15.

| Ref | Point | Verdict | Where it landed |
| --- | --- | --- | --- |
| R16 | "Verified on commit" and "flushed to the WebView before commit" are mutually exclusive only when an authoritative whole-representation digest exists | **Valid premise, inapplicable to C1** | C1 hashes received bytes for content-addressed storage; stream while staging, publish only after END/commit |
| R17 | Existing resumable retrieval does not cover panel artifacts — only the `/_a/` bundle route implements ranges (`src/server/appHost.ts:1204-1225`); `writeArtifact` handles no `Range` and never emits the resumable-gzip ack (`src/server/panelHttpServer.ts:1021+`), which `gatewayFetchService.ts:311-318` then rejects | **Valid — rev. 2's B5 was wrong** | B5 rewritten as a unified retrieval method |
| R18 | Every native-store operation needs an explicit namespace; an ambient "current workspace" lets a late-completing retrieval commit into the wrong index after a workspace switch | **Valid** | C1 API takes an explicit namespace, captured in the write handle |
| R19 | The promised shared conformance suite describes incompatible façades: desktop forwards non-GET with streamed bodies and admits worker routes (`src/node/panelAssets/panelAssetFacade.ts:322-330`); mobile denies both | **Valid** | P6 extended to desktop; the dynamic path is deleted, not fenced |
| R20 | An offline WebView must not be upgraded in place — offline DOM/storage/queued actions would cross into the authoritative runtime | **Valid**, and already implied by existing doctrine: *"A loaded WebView is a projection of one immutable panel runtime entity"* (`panelMaterializer.ts` docblock) | D2 lifecycle: discard and re-materialize |
| R21 | The launch-descriptor source is undefined; calling `getPanelInit` across the forest triggers build work and races tree changes | **Valid** | D1: server-issued snapshot, one consistency boundary |
| R22 | S1 belongs to Phase C, not A/C — in Phase A the entry document is still `no-store`, so a reload still costs pipe bytes | **Valid** | §8 |
| R23 | Phase C's proof should not port desktop's `tee()` implementation detail unchanged | **Valid** | Phase C proves equivalent stream-before-publication behavior across the native staging boundary |
| R24 | The precompression dependency overstates the gap: a persistent `TransportDerivativeCache` and background scheduling already exist | **Valid** — verified on-disk, keyed by source integrity with recorded byte length (`src/server/buildV2/transportDerivativeCache.ts:46-71`), scheduled at build (`panelHttpServer.ts:1004`) | B2 rewritten: coverage + exposure, not all of WS3c |
| R25 | The compensating-release alternative for concurrent materialization should be removed — the atomic server operation is already identified as the clean answer | **Valid** | §6.5 |

**R16 — the axis matters.** Phase C has no authoritative digest declared before
the transfer. Its digest is computed from the bytes actually received and names
the resulting content-addressed blob; it cannot verify completeness. Completeness
comes from the streaming RPC's authenticated END byte count. The normal network
contract is therefore the simpler one: send the HTTP head and chunks while the
same chunks enter native staging, publish the cache entry only after END and
commit, and leave a failed response visibly truncated. This is one streaming
path, not a verification bypass or an invisible retry. A future manifest with an
authoritative digest would reopen the verify-before-serve decision.

**R19 — the flip.** Rev. 2 was heading for "separate suites; desktop stays
dynamic". That is wrong. Panel `gatewayFetch` already tunnels over the shell
bridge on *both* platforms (`gatewayFetch.ts:97-100`), so desktop's dynamic
forwarding serves only panel code that bypasses it and raw-`fetch`es the origin —
traffic mobile already rejects. **A panel doing that works on desktop-remote and
breaks on mobile today.** That is an existing portability bug, not a platform
difference worth preserving in a contract.

### 2.7 Fourth review (rev. 3 → rev. 4)

> **Superseded in part by the rev. 5 scope cut (§0).** R29 (derivative
> production), R30 (route canonicalization), and the manifest-dependent halves of
> R16 and R27 addressed a prefetch design that no longer exists. They were
> correct against rev. 4 and are kept as the record of why that design was
> expensive. R26 (durable connection phase), R27b (D must not execute panel
> code), R28 (one contract, not one implementation), R32, R33 and R34 all still
> apply and are implemented.

All points verified valid. Two are blocking. Numbered R26+.

| Ref | Point | Verdict | Where it landed |
| --- | --- | --- | --- |
| R26 | The `paired` checkpoint has no durable representation: `StoredShellCredential` is `schemaVersion: 3` and strictly requires **both** pairings (`packages/mobile-webrtc/src/storedCredential.ts:28-44`), and `completeFreshMobilePairing` awaits `routeWorkspace` *before* `persistCredential(credential, controlPairing, route.workspaceReach)` (`packages/mobile-webrtc/src/freshPairing.ts:57-64`) | **Valid — blocks R13** | §6.5: a persisted phase union is a prerequisite of the readiness lifecycle |
| R27 | The §0 ambition committed to opening with the network off while D2 made that optional | **Valid** | §0 scope corrected |
| R27b | If D1 executes a panel WebView from persisted state before fresh init and a lease, **D1 is D2** and the gate is fictional | **Valid, and the sharper half** | D1 scope fenced explicitly |
| R28 | "One implementation" is unsupported: C2 specifies three servers with three parsers and header stacks | **Valid** | P3 rewritten as one contract + one suite + shared fixtures |
| R29 | B5's unified retrieval has no representation-production plan for app/RN bundles; derivative scheduling is panel-server-driven (`panelHttpServer.ts:1004-1015`) while `/_a/` gzips on the fly | **Valid** | B2 gains a build-store-level deliverable; B5 migration sequenced behind it |
| R30 | Route canonicalization is now storage/wire protocol and is undefined; parser differences across Node/Android/iOS split or fail-close the same legitimate request | **Valid** | New B6 |
| R31 | The §5 diagram still shows `gateway.fetch + Range` after B5 replaced it | **Valid** | Diagram updated |
| R32 | The conformance suite should assert `no-store` content is *rejected from manifest ingestion*, not merely "not cached" | **Valid** | Phase C proof |
| R33 | "Speed, then maintainability, then security" is risky contract language; invariants should be constraints with speed/maintainability ordered inside them — which is what the design already does | **Valid** | P3 priority paragraph |
| R34 | "Wider" prefetch conflicts with "recently opened only" | **Valid** | C3 |
| R35 | The physical-device observations link to no run IDs or retained artifacts | **Valid — resolved for the retained follow-up runs** | §2.5 + `docs/measurements/mobile-physical-baseline-2026-08-10.md` |
| R36 | S17/S18 are numbered before S13–S16 | **Valid** | §8 renumbered |

**R26 — why it blocks.** The readiness lifecycle's value is that the phone leaves
the pairing UI at `paired` and a crash resumes from that record. There is no such
record: the credential schema cannot express "paired, not yet routed", and the
workspace reach is an *input* to persistence rather than an output of it. The fix
is a discriminated union replacing the schema atomically — `schemaVersion: 4`
with an explicit `phase`, not a nullable `workspacePairing` that every reader
must reason about:

```
type StoredMobileConnection =
  | { phase: "paired"; schemaVersion: 4; credential; controlPairing; selectedWorkspaceId }
  | { phase: "routed"; schemaVersion: 4; credential; controlPairing; workspacePairing; selectedWorkspaceId }
```

Resuming `paired` means reconnecting control and requesting the selected
workspace route. This belongs to the startup track and is a prerequisite of R13,
not a follow-up to it.

### 2.8 Fifth review (rev. 5 → rev. 5.1)

All findings valid except two formatting claims that do not reproduce. One is a
missing mechanism rather than a wording gap.

| Ref | Point | Verdict | Where it landed |
| --- | --- | --- | --- |
| R37 | A native-store hit has **no byte path**: the API has no read/serve operation, and `react-native-tcp-socket`'s only write path is `Buffer.toString('base64')` in JS (`Socket.js:367`) | **Valid, and worse than stated** — verified that the module has no file-sending capability at all. A store hit forced through Hermes would be *slower than today's memory cache*, so C1/C2 and the warm-open criterion were not implementable | C1: `assetStoreLookup` returns an opaque handle; `socket.writeStoredAsset(handle)` as a vendored patch |
| R37b | Phase E's native sink leaves JS with no body to answer the pending request | **Valid** | Phase E: store-then-send cold path specified, with the returning first-byte cost named |
| R38 | The B1 and B2 audits are real gates, not "not a gate" | **Valid** — the no-deferral rule was over-applied | B1, B2 |
| R39 | P3 still claimed verification "against a declared identity", which rev. 5 removed | **Valid** | P3: the five actual storage guarantees |
| R40 | Cold population adds another JS→native base64 path and needs a bounded regression budget | **Valid** | New C3 + S18 |
| R41 | Stale text: P8's prefetch language, the cost model's "ambitious one", §11's "native resolves manifests", P3's Android/iOS fixture corpus | **Valid (all four)** | Each rewritten |
| — | Duplicate `## 6. Phases` heading; duplicated cleanup line | **Does not reproduce** — single occurrences in the current file | No change |

**R37 is the one that mattered.** Today a warm hit holds the buffer in JS and pays
one base64 encode. A durable store without a native send-file primitive would pay
a native encode, a JS decode, a JS re-encode and a native decode — so deleting
`MobileAssetMemoryCache` would have made repeat opens *worse*, while the
architecture diagram claimed the opposite. The fix is one native method, not a
native HTTP server, so the rev. 5 scope cut stands.

---

## 3. The cost model, quantified

Static arithmetic for **one cold 2 MiB (compressed) panel bundle**. To be
replaced by Phase 0 measurements.

```
2 MiB / 16 KiB = 128 bulk data-channel messages
```

| Stage | Per bundle | Mechanism |
| --- | --- | --- |
| Native → JS (WebRTC) | 128 bridge events, ~2.73 MiB of base64 string, 128 JS base64 decodes | `RTCDataChannel.ts:160` |
| Demux + stream enqueue | 128 `enqueue` → 128 `reader.read()` | `bulkMux.ts`, `panelAssetFacade.ts:565` |
| Cache tee | +1 full accumulated copy, +1 concatenating copy | `panelAssetFacade.ts:163,604` |
| JS → native (TCP) | **384 awaited writes**, ~2.73 MiB of base64 string, 384 native round trips | `panelAssetFacade.ts:568-570`, `Socket.js:367` |
| Native → WebView | loopback socket, one connection, no keep-alive | N1 |

**≈512 bridge crossings and ≈5.5 MiB of transient Hermes strings per 2 MiB of
panel code** — on the thread that also handles every RPC response, event
delivery, and React render.

Three observations that set priorities:

- **256 of the 384 outbound writes carry fewer than 10 bytes.** Coalescing them
  removes two thirds of the outbound crossings for a ~10-line change. Cheapest
  item in the plan; not the important one.
- **The important one is that this cost is paid at all, repeatedly.** Durability
  turns the whole table into a one-time cost per artifact version.
- **What remains after durability is a cold-path cost only**, paid on a first
  open, a new build, or an eviction. Two levers on it, in order: the inbound
  base64 hop (Phase E, decided with measurements) and prefetch (struck — it
  bought first-open latency at the price of a manifest protocol).

---

## 4. Principles

**P1 — Immutable code is not RPC data.** Digest-addressed artifacts get a
durable, content-addressed store and are served from it. Live RPC gets the pipe.

**P2 — Multi-megabyte artifact traffic does not cross the pipe or the bridge
twice.** *(Scoped down in rev. 5.)* Earlier revisions read "zero bytes of panel
code are touched by JavaScript", which was only achievable with a native server
and is not what the durable store delivers. The enforceable rule: a panel's code
crosses the WebRTC pipe **once per artifact version**, and a warm open moves no
artifact bytes over the pipe at all. The residual outbound base64 hop on a cache
hit is measured (Phase 0), not designed around in advance.

**P3 — One contract, one conformance suite, shared fixtures.** *(Corrected in
rev. 4 — R28.)* `docs/performance-optimization-plan.md` already commits to
parity; X3, R4 and R19 are each what happens without enforcement — a mobile
deviation, a mobile sequencing rule that desktop had already disproved, and a
panel-visible behaviour difference nobody chose.

Rev. 3 overcorrected: it declared the artifact plane "one implementation" with
platform code "confined to socket and storage adapters", while C2 specifies an
iOS `NWListener`, an Android `ServerSocket`, and Node HTTP — three request
parsers, three canonicalizers, three sets of status and header logic. A shared
native core (C++/Rust embedded on all three) is the only thing that would make
that sentence true, and this plan does not design one. So the honest and
sufficient target is:

- **one behavioural contract**, written down (§5 invariants, route
  the store contract in Phase C);
- **one conformance suite** that both origins execute (Phase F);
- **one shared cache-key function**, not three normalizers: both origins are JS
  servers over the same contract, and native sees only opaque keys and handles,
  so the drift surface is a single function exercised on both platforms rather
  than a cross-language fixture corpus.

Where desktop and mobile cannot share code, they must share a test that proves
they behave identically. That is the enforceable version of parity.

**Priority ordering, stated as constraints.** *(Revised in rev. 4 — R33.)* This
plan optimises for **speed, then maintainability** — ordered *within* the
security invariants, which are constraints rather than competitors. The
invariants that do not get traded, restated in rev. 5 terms (R39 — the old
wording claimed verification "against a declared identity", which no longer
exists): **only successful immutable 200 responses are persisted; the complete
received body is hashed before the index entry is published; blob and metadata
publication is atomic; a hit validates index/sidecar structure and the expected
stored length; a truncated or failed stream never publishes an entry.**
Digest-on-write proves stable *storage* identity — it does not prove
correspondence to a server-declared artifact, and must not be described as if it
did. Further: the panel loopback origin remains
unauthenticated and therefore serves only non-secret immutable content and fails
closed; panel RPC and uploads stay on the authenticated bridge; the downloaded
executable bundle is verified in full on write. Several decisions below
(verify-then-serve, the immutable-only origin, declared sandbox trust) could be
argued from more than one axis, so each records *why* it was taken. Where a
decision also improves security, that is noted as a consequence rather than used
as the justification — otherwise someone later re-derives the opposite conclusion
from the wrong premise.

**P4 — One owner per contract.** Tree refresh, WebView reload, session lifetime,
and credential persistence each get exactly one owner. Today they have three,
one, none, and two respectively (X6, N6, R4).

**P5 — Resolve by lifecycle, not by clock.** Applies to the ICE candidate wait
(X5) and the `preparing` poll loop (N5). It does not mean deleting ceilings that
keep a wedged native layer from hanging startup forever.

**P6 — One request path, one policy, on both platforms.** *(Revised after R3;
extended to desktop in rev. 3 after R19.)* Rev. 1 proposed a native server
consulting a JS-produced authorization table, with misses handed back to JS —
two request-processing paths and a replicated policy cache with unspecified
invalidation. The rule is now:

> **The panel loopback origin serves immutable GET content. Nothing else. On
> every platform.**

Non-GET ⇒ 405; anything outside the panel-asset path policy ⇒ 403. Worker
routes, management routes, uploads and RPC never reach that origin at all — they
ride the authenticated bridge, which is where `gatewayFetch` already puts them
(`workspace/packages/runtime/src/shared/gatewayFetch.ts:97-100`: *"Panel: tunnel
over the shell bridge. No bearer ever rides an HTTP plane"*). A miss is fetched
over the pipe by the same JS server that serves the hit — one request path, one
policy, in one place.

Desktop's façade is brought to this rule rather than exempted from it (R19). Its
dynamic-forwarding path exists for panel code that bypasses `gatewayFetch` and
raw-`fetch`es the origin; mobile already rejects exactly that traffic. Keeping
both behaviours would institutionalise a panel-visible portability difference
that nobody designed. See the migration task that opens Phase B2.

**P7 — Fail loud.** A native store error, a truncated write, or a corrupt index
is reported, never silently downgraded into "refetch forever".

**P8 — Interactive work outranks speculative work, always.** This applies to
CPU, memory, subprocesses, disk and network. Artifact prefetch is struck
entirely in rev. 5, so the live case is server-side speculation:
workspace-wide compile/prewarm is prohibited unless bounded by explicit priority
and resource contracts (R15). Store population is not speculation — it is the
tail of a request the user made — but it still may not outrank the response it
rides behind (C3).

**P9 — Readiness is a monotonic product contract, not one boolean.** Identity
paired, ingress routable, shell paintable, and fully reconciled are distinct
facts. Each transition is published once by its owner and is driven by the
underlying lifecycle, never inferred from a delay. A caller waits only for the
level it actually needs (R13).

---

## 5. Target architecture

```
  WebView ──► loopback :<stable port>   [JS server — unchanged]
                    │
                    ├─ WebView HTTP cache hit ──────────────► never reaches us
                    │
                    ├─ store hit  ─► JS writes head; native writeStoredAsset
                    │                streams the body file → socket
                    │                (no pipe, no demux, no body in Hermes)
                    │
                    └─ store miss ─► gateway.fetch over the pipe
                                     ─► stream to socket AND populate store
                                        (digest-on-write, tee — as desktop does)

  native durable store          index: (server, workspace) + route+vary → digest
  (application-support storage) blobs: <digest>, bytes exactly as received
                                lookup → opaque handle (never a path)
                                LRU byte cap; no pins, no prefetch
```

Cache tiers, in order of cost:

- **T1 — WebView HTTP cache.** Free, per-origin, survives launches because the
  loopback port is persisted (`panelAssetFacade.ts:72-90`). Currently disabled
  for managed panels — Phase A re-enables it.
- **T0 — Durable content-addressed store.** Digest-on-write over the bytes as
  received, LRU-capped, on non-purgeable storage. Same contract as desktop's
  `AssetDiskCache`.
- ~~T2 — JS memory LRU~~ — **deleted** in Phase C. It exists only because T0 does
  not.

Invariants:

- A stored blob is keyed by the digest of the bytes actually received; the
  server declares no identity, so there is nothing to disagree with. Only
  immutable 200 responses are persisted; the full body is hashed before the index
  entry publishes; publication is atomic; a truncated stream publishes nothing.
- Index entries are scoped by `(server identity, workspace identity)`. Blob
  bodies dedupe globally by digest; index entries do not.
- `no-store` content is never stored at any tier.
- After Phase B the panel loopback origin serves immutable GET assets only, on
  both platforms; everything else fails closed.

The startup contract is a separate monotonic lifecycle, not part of the asset
origin and not a parallel connection path:

```
paired ──► ingress-routable ──► shell-ready ──► reconciled
  │               │                  │               │
  │               │                  │               └─ extensions/deps complete
  │               │                  └─ cached tree or roots can paint
  │               └─ workspace pipe can authenticate; route may return
  └─ device credential durably committed; pairing UX may complete
```

Failure attaches to the phase that failed. Thus an absent answerer is not shown
as a generic ICE timeout, and slow workspace reconciliation does not leave the
device claiming it is still pairing.

---

## 6. Phases

### Phase 0 — Instrumentation and baseline · **gate for everything**

No optimisation lands before its baseline exists.

- Per-request façade telemetry: route, tier hit (WebView cache / store / miss),
  bytes, time-to-first-byte, total, bridge-crossing count. Emitted as smoke
  phases so `scripts/cli/mobile-smoke.mjs` (which already parses `phase=` lines,
  `:511`) captures them in CI artifacts.
- Startup phase timings around the existing markers plus new ones per pipe
  connect and per panel materialize → first paint. WebRTC markers split
  signaling join, offer sent, answer received, first candidate pair selected,
  data channels open, authentication complete, and hello complete; the observed
  4.5 s offer → answer interval is otherwise not actionable.
- Bootstrap phase timings and states for `paired`, `ingress-routable`,
  `shell-ready`, and `reconciled`, including the blocking operation and owner of
  each transition. The 240 s pairing stall is the first regression fixture.
- A resume trace: one line per refresh/reload/cache-clear with its trigger.
- Bundle transfer rate + range-window count for `bundleDelivery`.
- **Bytes-per-rebuild**, from day one, so Phase C's delta benefit is visible.
- Process-tree high-water RSS/PSS, child count, build count, dependency bytes
  written, and post-ready CPU for server, workspace Node, esbuild, workerd,
  extension hosts, Electron, ADB and smoke-harness children. Measurements cover
  cold bootstrap, settled idle, first panel open, and cleanup. A test is not
  complete until its owned processes are gone.
- Harness preconditions and structured outcomes: a desktop provider is present,
  the expected physical device is discovered, provision and verify operations
  completed successfully, and their returned values satisfy the scenario. Eval
  source text and an agent completion report are never product evidence.

**Proof:** a committed baseline (cold launch, warm resume, panel open, panel
reopen) referenced from `docs/measurements/`, plus a replay of the no-provider
false-pass trajectory that the validator now rejects.

### Phase A — Reclaim what we already have · days, not weeks

Four changes, none architectural, all on the path to the end state.

1. **Re-enable the WebView cache for managed panels.** `PanelWebView.tsx:1178` →
   `cacheEnabled` unconditionally true, `cacheMode="LOAD_DEFAULT"`. Safe because
   the gateway marks the HTML entry `no-store` and hashed artifacts
   `public, max-age=31536000, immutable` (`panelHttpServer.test.ts:347`), and the
   façade replays those headers verbatim (`:481`, `:498`). Add a regression test
   asserting the entry document's `no-store` reaches the WebView unaltered.
2. **Stop clearing the asset cache on background.** `useAppLifecycle.ts:72` drops
   `trimMemory()` from the background branch; keep it on `memoryWarning` only.
3. **Coalesce the chunked-transfer writes.** `streamPassthrough` (`:562-573`)
   builds one buffer per chunk — `<hex>\r\n` + payload + `\r\n` — and issues a
   single awaited write.
4. **Drop the duplicate lease snapshot.** Remove the second `syncRuntimeLeases()`
   at `shellClient.ts:1116` (C10).

**Dropped after R12:** a JS keep-alive HTTP parser. A hand-written multi-request
HTTP parser is throwaway complexity for a per-request connection cost that Phase
0 has not shown to matter. Serving cache hits with `Content-Length`
(`writeBufferedAsset` already knows it, `:518`) stays — that is not the parser.
If Phase 0 shows connection setup is material, it returns with evidence.

**Must not break:** the `no-store` path; the 405 non-GET rejection; the
worker-route denial; the `x-vibestudio-content-gzip` → `Content-Encoding: gzip`
translation.

### Phase B — Kill the last pipe dependency on a warm open

Two changes, both deletions of dynamic behaviour. Neither needs a manifest.

**B1 — The panel entry document becomes immutable per `buildKey`.** *(Audit
completed — the finding makes this much smaller than rev. 5 assumed.)*

The audit asked what depends on per-request HTML. **Nothing does.** The served
entry body is a pure function of build-determined inputs:

- `serveActivatedPanelResource` takes `build.htmlArtifact.content` and rewrites
  asset URLs to `../../__vibestudio/panel-build/${buildKey}/`
  (`src/server/panelHttpServer.ts:774-789`). Inputs: the HTML artifact, the build
  key, and the build's artifact path set. No request-derived value enters the
  body.
- The other entry path ends `res.end(build.htmlArtifact.content)` verbatim
  (`:967`).
- `contextId`, `ref` and `buildKey` arrive as query params or via `Referer`
  (`:516-523`, `:802-807`) and **select which build to serve**. They do not
  template it.

So the entry document is `no-store` (`:1033`) not because it varies per request
but because it was designed as the *mutable pointer* to a build — the comment
above it says exactly that. That reason no longer holds on the panel-open path:
`buildPanelUrl` already pins a validated 64-hex `buildKey` in the query and
**throws** without one (`packages/shared/src/panelFactory.ts:121-132`). The
pointer indirection is already resolved by the client.

Therefore B1 is not a restructuring. It is:

1. Serve the entry document as `public, max-age=31536000, immutable` **when the
   request pins a valid `buildKey`**; keep `no-store` for the unpinned developer
   route, which is the only caller that still needs pointer semantics.
2. **Normalize the entry-document cache key to `(source, buildKey)`.** The façade
   keys on `pathname + search` (`assetPathPolicy.ts:150`), so the full query would
   split one build's HTML across every `contextId` — correct but wasteful, since
   the body does not depend on `contextId` or `ref`.

No change to `buildBridgeBootstrapScript` and no volatile state to relocate: the
bootstrap already carries the per-launch state, which is why the HTML never
needed to.

**B2 — One origin contract, both platforms.** With B1 landed, the panel loopback
origin serves immutable GET assets and nothing else — on desktop as well as
mobile. Desktop's non-GET body forwarding and worker-route admission
(`src/node/panelAssets/panelAssetFacade.ts:322-330`) are **deleted**: that traffic
belongs on the authenticated bridge, which is where `gatewayFetch` already puts it
on both platforms
(`workspace/packages/runtime/src/shared/gatewayFetch.ts:97-100`).

*(Audit completed — the migration list is empty.)* The prerequisite was finding
panels that raw-`fetch` the origin instead of using `gatewayFetch`. **There are
none.** No `fetch("/_r/w/…")` anywhere in `workspace/`, no relative
`fetch("/…")` in any panel or app outside `node_modules`, and no `XMLHttpRequest`
/ `EventSource` against the origin. So the deletion has no known callers to
migrate and is unblocked.

Two caveats that keep this honest rather than closed:

- A grep cannot see a dynamically-assembled URL, and panels are user-authorable.
  The deletion therefore lands with the **loud** rejection it already has —
  405/403, not a silent drop — so a panel doing this fails visibly and points at
  `gatewayFetch` (P7).
- The rejection asymmetry is what made this worth auditing at all: such a panel
  works on desktop-remote today and already fails on mobile. Deleting the desktop
  path removes an existing portability difference; it does not create one.

**Proof:** a warm panel open performs zero `gateway.fetch` calls; both origins
reject non-GET and worker routes identically; the entry document is served from
cache like any other artifact.

### Phase C — A durable store behind the existing JS server

The JS loopback server stays. What changes is what sits behind it: a native,
durable, content-addressed store replacing the 256 MiB Hermes LRU.

**Why not a native server.** A native loopback server would remove the outbound
base64 hop on cache hits — and would cost two hand-rolled HTTP implementations,
a third URL canonicalizer, and a native/JS ownership boundary through the middle
of the request path. After Phase B a hit is a local disk read plus one base64
write, with no WebRTC hop and no multi-MB traffic through Hermes. That is the
large win; the rest is a rewrite for the remainder. If Phase 0 later shows the
outbound hop dominating warm opens, it becomes its own justified change.

**C1 — The desktop cache, ported.** `src/node/panelAssets/assetDiskCache.ts` is
the contract: digest-on-write over the bytes as received, path+forward-headers
index, single-flighted misses, `no-store` never cached, LRU byte cap, and the
existing stream-while-populating `tee()`. Mobile gets the same semantics over
native file storage. Because the digest is defined by what was received, there
is no declared identity to verify against and no verify-then-serve tradeoff —
the question disappears with the manifest layer that created it.

- **Native surface** on `VibestudioMobileHost`, alongside the existing
  bundle-write methods. Every operation carries an explicit namespace — there is
  no ambient "current workspace", so a retrieval completing after a workspace
  switch cannot land in the newly selected workspace's index:

  ```
  assetStoreLookup(namespace, key)      → { handle, size, metadata } | null
  assetStoreOpenWrite(namespace, key)   → writeId   // namespace captured here
  assetStoreAppend(writeId, base64) · assetStoreCommit(writeId, metadata)
  assetStoreTrim(maxBytes) · assetStoreClear()

  socket.writeStoredAsset(handle, callback)          // the body never enters JS
  ```

  **`writeStoredAsset` is the load-bearing part, and rev. 5 shipped without it
  (R37).** `assetStoreLookup` returns an **opaque handle**, never a path — native
  validates that the handle belongs to the artifact store and streams the file
  into the already-accepted socket with backpressure, calling back on completion.
  A JS-supplied file path is never trusted.

  Without this primitive there is no byte path at all: `react-native-tcp-socket`
  has no file-sending capability (verified — no `sendFile`, no
  `FileInputStream`), and its only write path is `Buffer.toString('base64')` in
  JS (`Socket.js:367`). A store hit would then have to cross into Hermes as a
  base64 string, be decoded, be re-encoded, and be decoded again natively:
  **strictly slower than today's Hermes memory cache**, which already holds the
  buffer JS-side and pays one encode. Deleting `MobileAssetMemoryCache` in favour
  of a durable store is a regression until `writeStoredAsset` exists.

  *Where it lives, decided:* the loopback socket is owned by
  `TcpSocketModule`'s native client map, so the method goes **inside
  `react-native-tcp-socket` as a vendored patch** (`patches/`,
  `patchedDependencies` — the mechanism already exists). The alternative, moving
  the loopback socket into our own native module, is most of the native-server
  work this revision deliberately struck. JS keeps HTTP parsing, policy, headers
  and request lifecycle; native owns body transfer only.

- **Namespace** is `(server identity, workspace identity)`, where server identity
  is the **control pairing's DTLS fingerprint** (`controlPairing.fp`) — already
  persisted, already the value the transport pins, stable across reconnects, and
  correctly invalidating if a server regenerates its identity. Blob bodies dedupe
  globally by digest; index entries do not.
- **Storage location.** Application-support/files storage, not the OS-purgeable
  cache directory the RN bundle uses (`VibestudioBundleStore.kt:78`). Blobs are
  excluded from device backup; the index is not.
- **LRU** byte cap as a named constant (start 256 MiB), trimmed on write and on
  `memoryWarning`.
- **`MobileAssetMemoryCache` is deleted**, not shrunk. A 256 MiB Hermes LRU in
  front of a durable native store is duplicated bytes.
- **The index key is desktop's, character for character.** Port
  `assetCacheKey(gatewayPath, forwardHeaders)` (`assetDiskCache.ts`), do not
  re-derive it. Without a manifest there is no fail-closed route lookup, so a
  normalization difference degrades to a cache *miss* rather than a 404 — cheap
  enough that this needs no canonicalization protocol, and silent enough that it
  would never be noticed. Two implementations normalizing `%2F`, dot segments,
  duplicate query keys or `contextId` differently would split entries for one
  artifact and quietly halve the hit rate. One key function, exercised by the
  Phase F suite on both platforms.

**C2 — Serve hits without the WebRTC hop.** JS parses the request, applies
policy, and writes the HTTP head; the body goes out via `writeStoredAsset`. No
`gateway.fetch`, no bulk channel, no inbound base64, no demux, and no artifact
body in Hermes. A miss streams over the pipe exactly as today and populates the
store on the way through.

**C3 — A bounded cold-population regression (R40).** Populating the store costs
cold loads *more* than today: every chunk now also crosses to native via
`assetStoreAppend(base64)` in addition to the socket write. Before Phase E that
is a second JS→native base64 path on the cold path. Durability justifies a modest
first-open regression; it does not justify an unmeasured one. Phase C therefore
carries an explicit budget — cold-open time-to-interactive, JS-thread
responsiveness during the load, peak Hermes and native memory, and the added
bridge crossings from population — and the regression must be bounded and stated
rather than hidden behind the warm-open criteria (S18).

**Proof:** the desktop suite ported verbatim (second-request-zero-pipe-fetch,
header-varied entries, never-cache-`no-store`, stream-before-population-
completes); a process-restart test — relaunch, reopen a panel, zero pipe bytes;
a namespace test — a retrieval that completes after a workspace switch does not
appear in the new workspace's index.

### Phase D — Paint from durable local state

A startup-speed change, independent of everything above. Not offline: the pipe
is required, it is simply no longer on the critical path of first paint.

The client already fetches workspace info and tree roots at startup
(`shellClient.ts:271-277`). Persist those results with the tree revision they
came from, paint from them immediately labelled **reconciling**, and reconcile
when the pipe is up. A persisted revision that does not match the server's is
discarded, not merged — which is why this needs no new server surface and no
snapshot RPC.

**D must not execute panel code from persisted state.** It paints shell chrome,
tree state, and per-panel reconciling placeholders. A WebView materialized before
fresh `getPanelInit` and a lease would be a second, non-authoritative runtime —
the thing this plan struck as a goal. Panel execution begins after authoritative
materialization, as it does today.

This composes with `shell-ready` in the §6.5 readiness lifecycle.

**Proof:** launch paints workspace and tree with no pipe round trip, labelled
reconciling, and converges; no panel realm exists before its lease.

### Phase E — The inbound base64 hop: a decision that must actually be made

*(Restored in rev. 5 after being struck. It was struck because it was "gated",
and a gate with no owner is how a real question becomes a permanent maybe.)*

Everything up to here removes artifact bytes from the **warm** path. The cold
path is untouched: `react-native-webrtc` base64-encodes every binary
data-channel message natively and decodes it in Hermes with a pure-JS decoder
(`node_modules/react-native-webrtc/src/RTCDataChannel.ts:160`,
`base64.toByteArray`). For a 2 MiB bundle that is 128 bridge events and ~2.73 MiB
of transient JS string, on the thread that is also rendering. A first open, a new
build, and a cache eviction all pay it.

The fix is a patched `react-native-webrtc` exposing a registerable **native bulk
sink**: bulk-channel DATA frames for an artifact stream reach native storage
without ever materialising as a JS string, routed by stream id. The repo already
vendors patches (`patches/`, `patchedDependencies` in `package.json`), so the
mechanism is established, not novel.

**This phase is a question, and the question has to be answered with evidence.**

> **"We did not evaluate it" is a failed phase, not a skipped one.** So is "it
> looked like a lot of work." The acceptable outcomes are *built* or *measured
> and rejected on the numbers* — nothing else closes it.

Decide it honestly, which means deciding the criteria **before** running the
measurement, so the answer cannot be reverse-engineered from whoever is tired:

- **Build the spike far enough to measure.** An estimate is not a result. The
  comparison is a real patched build against a real unpatched build, on a
  physical device, over the same artifact set.
- **State the threshold in advance.** Phase 0 gives cold-open time-to-interactive
  and its JS-thread share. Write down, before the spike, what fraction
  attributable to the base64 hop justifies the fork — and what fraction means it
  does not. Then honour whichever side the number lands on.
- **Measure what the user feels, not what is easy to count.** Bridge crossings
  and string allocations are proxies. The question is cold-open latency and
  main-thread responsiveness *during* a cold open — including whether ordinary
  RPC still stalls behind an artifact transfer.
- **Cost the "yes" honestly, in advance too.** A patch file against a
  fast-moving dependency; a re-review on every RN or `react-native-webrtc`
  upgrade; the 16 KiB corruption constraint (C5) lives in the same layer being
  patched, so the patch must preserve it and prove it. If the number says yes,
  this cost is accepted deliberately — not discovered afterwards.
- **If it ships, it is negotiated, not fallback-guarded.** Native-sink support is
  a **required capability in the existing hello handshake**, checked before any
  transfer begins — the same shape as the contract-version check that already
  hard-closes on mismatch (`webrtcClient.ts:824-831`). A build without support
  stays on the prior release architecture by design. An *unexpected* registration
  failure fails visibly (P7). No silent fallback: that would preserve two bulk
  implementations forever, which is what rev. 2's reviewer correctly killed.

**If it ships, the whole cold path must be specified (R37b).** A native sink that
consumes DATA frames leaves JS with no body stream to answer the pending WebView
request. The coherent shape is **store-then-send**:

```
WebView request
  → JS opens the gateway stream and a native store write
  → native bulk sink writes the artifact into the store
  → completion returns to JS
  → JS writes the HTTP head
  → native writeStoredAsset streams the stored body to the socket
```

Note what that costs, because it is a cost this revision thought it had removed:
cold first-byte becomes the full transfer — the same latency profile as the
verify-then-serve design that left with the manifests. It returns through a
different door, and Phase E's pre-registered threshold must account for it rather
than discover it. The alternative — native streaming DATA into the socket and the
store simultaneously — recreates the partial-response path that was deliberately
rejected, so store-then-send is preferred and the latency is measured.

**Sequenced last** because its value depends on how rare cold opens actually are
after Phase C — which is exactly why it must be measured after C rather than
argued before it.

**Proof:** a written decision record with the pre-registered threshold, the
measured numbers from both builds, and the outcome. Either the patch and its
negotiated capability, or a recorded rejection future readers can re-derive.

### Phase F — Make it stay fixed

Regression pressure is why X3 and R4 both happened.

- **One conformance suite, because there is one contract.** It covers both
  `src/node/panelAssets/panelAssetFacade.ts` and the mobile façade on the same
  behaviours: origin policy (immutable GET only; 405/403/404 for everything
  else), store semantics, `no-store` never stored, digest-on-write, single-flight
  misses, gzip translation, LRU eviction. Divergence fails CI (P3). Both are JS
  servers over the same cache contract, so this is a shared suite over shared
  semantics rather than two implementations chasing each other.
- **The desktop dynamic-forwarding path is deleted, not tested** (Phase B2).
- **Budgets, report-only then enforced** (the `performance-optimization-plan.md`
  WS4 pattern): pipe bytes per warm panel open (target zero), bridge crossings
  per panel open, tree refreshes per resume (target one), WebView reloads per
  no-op recovery (target zero).
- **The smoke harness asserts invariants, not just timings**: a warm open that
  touches the network fails the build.
- **The agentic provision scenario is harness-validated, not
  completion-report-validated.** Its preflight requires one authenticated
  desktop provider and the requested ADB device. Its pass record is constructed
  only from successful structured `devices` → `provision` → `verify` results;
  mentioning those operations in eval source or in final prose is irrelevant.
  The captured phone phase/screenshot must agree with the structured result.
  The real false-positive trajectory (zero providers, no provision call, final
  "could not start provisioning") is a permanent negative fixture.
- **Cleanup is asserted.** Managed server/Electron ownership is instance-scoped;
  after a run, no owned Electron wrapper, Gradle daemon, emulator, ADB logcat,
  npm installer, esbuild or workspace child remains. Process high-water and
  cleanup status are artifacts of the run, not manual observations.

---

## 6.5 Cross-cutting: startup and recovery

Runs in parallel with A–F; different files, different reviewers.

**Prerequisite: a durable connection phase (R26)**

The lifecycle below commits `paired` before `ingress-routable` so the pairing UI
can finish early and a crash can resume from that record. **There is no such
record today, so this must land first.** `StoredShellCredential` is
`schemaVersion: 3` with a strict key set requiring *both* `controlPairing` and
`workspacePairing` (`packages/mobile-webrtc/src/storedCredential.ts:28-44`), and
`completeFreshMobilePairing` awaits `routeWorkspace` *before* calling
`persistCredential(credential, controlPairing, route.workspaceReach)`
(`packages/mobile-webrtc/src/freshPairing.ts:57-64`) — the workspace reach is an
input to persistence, not an output of it. The device can therefore be "paired"
only in memory.

Replace the schema atomically with a discriminated union — **not** a nullable
`workspacePairing` beside the existing shape, and not a second marker key:

```
type StoredMobileConnection =
  | { phase: "paired"; schemaVersion: 4; credential; controlPairing; selectedWorkspaceId }
  | { phase: "routed"; schemaVersion: 4; credential; controlPairing; workspacePairing; selectedWorkspaceId }
```

Resuming `paired` reconnects control and requests the selected workspace route;
resuming `routed` is today's path. One migration from `schemaVersion: 3`, and the
strict-key validation stays strict — a phase-less record is invalid, not
optimistically upgraded (P7).

**Bootstrap depth exposed by the physical run (R13)**

The present `hubControl.routeWorkspace` awaits `ensureWorkspaceRuntime`, whose
one promise resolves only when the child publishes the full late ready record.
`completeFreshMobilePairing` awaits that route before it persists the credential
and exposes success. This is why a healthy authenticated control pipe can leave
the phone saying "Pairing" for minutes.

Replace the boolean with the §5 lifecycle and make ownership explicit:

1. The hub owns `paired`: the device credential and stable control reach are
   committed durably. The mobile UI leaves pairing at this point and shows the
   selected workspace as preparing; a crash/relaunch resumes from this record.
2. The workspace child owns `ingress-routable`: identity is loaded and its
   authenticated workspace ingress is listening. `routeWorkspace` waits for
   exactly this transition, arms the existing child reach, and returns it. It
   does not wait for extension activation, dependency installation, panel
   compilation, or authority prewarm.
3. The shell/workspace session owns `shell-ready`: the smallest workspace-info
   and tree-root contract needed to paint is available. Durable cached state may
   paint earlier, but is labelled reconciling rather than mistaken for current
   authority.
4. The workspace child owns `reconciled`: required extensions and dependencies
   have settled. Optional/speculative compilation is not part of this state.

This is one bootstrap lifecycle over the existing control and workspace pipes.
There is no optimistic success, duplicate routing RPC, polling side channel, or
compatibility fallback. Each failure is durable enough to render and retry from
its owning phase.

The resource consequence is part of the contract: publishing any readiness
state must not launch unbounded speculative work. The current checkout removes
the post-ready `prewarmWorkspaceBuilds()` call and keeps panel/worker units lazy.
Any proposal to restore it must first satisfy the Phase 0 memory/concurrency
budget and P8; "after ready" is not a resource boundary.

**Startup as a readiness transaction**

- **Establish both pipes concurrently on the reconnect path**
  (`connect.ts:373-390`), matching desktop (`serverSession.ts:437-446`). Safe
  under the actual credential contract — see §2.4 R4. Preserve failure
  semantics: if either fails, close the other and surface the original error.
  **Credential persistence goes behind a single serialized writer** (P4) as
  insurance. First pairing, where `onPaired` genuinely fires, keeps its ordering.
- Split `ShellClient.init` (`shellClient.ts:962`) into required-for-paint
  (transport, `workspaces.getInfo()`, façade bound, panel tree roots) and
  deferred-and-concurrent (account profile — currently awaited inside
  `connectWorkspace` at `:1075` — notifications, approvals, host-target
  verification).
- Move `ensureReactNativeHostTargetReady` off the critical path (N5): run it
  concurrently; a different approved build triggers the existing
  activation/reload flow; `approval-required` becomes a UI state, not an init
  rejection. Replace the 1 s `preparing` poll with a server event if one exists
  (open question 3); otherwise keep the poll, off the paint path (P5).
- **Panel materialization concurrency is downgraded (R5).** Acquiring the lease
  on the tree's runtime id while `getPanelInit` runs can leave a lease held for a
  retired entity if the identity advances. The managed-pending-`buildKey` branch
  already leases on the tree id without calling `getPanelInit`
  (`panelMaterializer.ts:70-85`), so this is not forbidden ground — but it
  requires a **server operation that atomically resolves panel init and acquires
  the lease for the same incarnation**. Absent that operation, keep the present
  ordering; the win was small. *(Rev. 3 — R25: the compensating-release
  alternative is deleted. It was a second, failure-prone path for a minor
  optimisation, and the atomic operation was already named as the clean answer.)*

**Signaling availability is not transport latency (R14)**

- Preserve the 30 s connect timeout as a last-resort ceiling, but do not tune it
  as the stale-room fix. The signaling answerer owns a presence/lease lifecycle;
  if no answerer owns the room/boot identity addressed by the offer, rendezvous
  fails immediately with a typed `answerer-unavailable` result.
- Keep room and boot identities coupled. A saved pairing that names a retired
  room must not look like a temporarily slow current server. Recovery obtains a
  current reach through the existing control-plane contract; it does not guess a
  room or add a relay/fallback transport.
- Measure the live-room path by phase. The observed ~4.5 s offer → answer sample
  is a signaling/answerer budget until evidence assigns it more narrowly; direct
  host ICE and a successful authenticated pipe are evidence against calling it
  generic WebRTC throughput.

**One owner for recovery**

- `ShellClient` owns tree refresh; its `registerResubscribeHandler` (`:1151`) is
  the only caller of `panels.refresh()` on recovery. `MainScreen.tsx:938` and
  `useAppLifecycle.ts:56` stop refreshing; foreground triggers
  `transport.reconnect()` only.
- **Reload WebViews conditionally.** `MainScreen.tsx:325` reloads every managed
  WebView on every recovery. Reload only when the panel's runtime identity or
  `buildKey` changed, or its bridge session is dead — the condition
  `needsMobilePanelMaterialization` (`panelMaterializer.ts:47`) already encodes.
- Refresh and reload paths single-flight.

**Panel session and panel RPC**

- Pre-open the panel session during materialization (C7), owned by the lease
  (N6): created when the lease is acquired, torn down when it is released or the
  runtime identity changes. `ensurePanelSession` becomes a lookup with a lazy
  fallback. Grants are one-shot, so the open path stays the single place that
  fetches one.
- **Large panel RPC bodies stay on the authenticated panel session (R6).**
  Rev. 1's option (b) — routing large panel reads through the asset origin — is
  **deleted**. Panel RPC bodies can be user-specific, capability-gated, or
  sensitive; the asset origin is unauthenticated and is deliberately forbidden
  from addressing management routes (`gatewayFetchService.ts:242`). Remaining
  options, and only if Phase 0 measurements justify them: raise the
  one-chunk-in-flight limit against a byte watermark (the buffer cap already
  exists, `bridgeStream.ts:311-325`), or move the relay to a **separate
  authenticated native channel** (`WKScriptMessageHandlerWithReply` /
  `WebMessagePort`) — which is not the asset origin and carries none of its
  constraints.

**Native bundle delivery and launch**

- Short-circuit re-download (C12): consult `activeBundlePathIfMatches(buildKey,
  integrity)` — exists on Android with zero callers, needs an iOS twin.
- **Launch verification: declared sandbox trust.** *(Decided.)* Rev. 1 called a
  path + size + file-identity check "tamper-evident". It is not — a same-size
  in-place modification preserves all three — and the plan will not use that
  word for it. The position taken is: **we trust the application's private data
  directory, and the code says so in those words.** The activation record
  already sits on exactly that boundary, so an attacker who can rewrite the
  bundle in place can equally rewrite the record; adding a
  Keystore/Keychain-authenticated HMAC would move the boundary only if the record
  and the bundle had different trust properties, and they do not. What the fast
  path is *for*, stated in the code comment: catching corruption, truncation, and
  staleness — not defeating an attacker already inside the sandbox.

  The guarantees that remain load-bearing, and must not be quietly dropped
  alongside the fast path:
  - **Full verification on write** (`finalizeBundleWrite` already hashes), where
    the bytes are streaming through anyway. This is the real supply-chain check.
  - **Path confinement** — the bundle must live under the app-owned bundle root
    (`isUnderBundleCache`, `VibestudioBundleStore.kt:78`), canonicalised.
  - **Full re-hash on any disagreement**, moved off the main thread with a
    visible "verifying" state rather than a frozen launch.

  If the trust boundary ever changes — a shared or externally-writable bundle
  location, or a threat model that includes local malware with app-data access —
  this decision is void and the Keystore/Keychain-authenticated record is the
  replacement. Record that condition in the code comment, not just here.

---

## 7. Sequencing

```
Phase 0 ──► A ──► B ──► C ──► D ──► E (decide with evidence)
                  └──────────► F (starts with C)
   startup + recovery track runs parallel from Phase 0
   bundle delivery/launch: independent, schedule by X7
```

- **Phase 0 gates everything.** No optimisation merges without a before/after.
- **A first**: hours of work, removes the most embarrassing losses, and makes
  later benefit measurable in isolation rather than confounded.
- **B before C**: with the entry document still `no-store`, a warm open keeps a
  pipe round trip and the store cannot own the whole open path.
- **C before D** only by convenience — they are independent, and D can move
  earlier if startup latency measures worse than panel latency.
- **E after C, and E must close.** Its value depends on how rare cold opens are
  once the store exists, so it cannot be argued before C. It is the one phase
  whose deliverable may be a rejection — but a *recorded, measured* rejection.
  Leaving it open is not a permitted outcome.
- **No external prerequisites.** Precompression coverage, manifest surfaces and
  derivative services were prerequisites of the prefetch design and left with it.

---

## 8. Success criteria

Thresholds stay blank until Phase 0 fills them; the *shape* is fixed now so the
numbers cannot be chosen to fit.

| # | Criterion | Phase | Measured by |
| --- | --- | --- | --- |
| S1 | A panel opened, backgrounded, and reopened costs zero pipe bytes — entry document included | C (needs B1) | tier counters. Achievable: the audit confirmed the entry body is build-determined, so B1 is a cache-control + cache-key change |
| S2 | The same holds across process restart | C | relaunch smoke |
| S3 | A warm panel open moves no artifact bytes over the pipe and **no artifact body through Hermes** — served via `writeStoredAsset` | C | crossing counter |
| S3b | A warm hit is no slower than today's Hermes memory-cache hit | C | before/after on repeat open (R37) |
| S4 | A server-side rebuild re-transfers only the artifacts whose bytes changed | C | bytes-per-rebuild |
| S5 | Launch paints workspace and tree with no pipe round trip, labelled reconciling, and converges | D | startup phase trace |
| S6 | No panel realm exists before its lease | D | materialization trace |
| S7 | A resume with no server-side change: exactly one tree refresh, ≤1 lease sync, zero WebView reloads | recovery | resume trace |
| S8 | Launch-to-first-paint improves **and its variance narrows** | startup | phase timings |
| S9 | A panel's first RPC no longer includes grant + session setup | recovery | per-call trace |
| S10 | Control-plane RPC latency during a cold panel load stays within a bounded factor of idle | C | sampled during open |
| S11 | Both origins pass one conformance suite, including identical rejection of non-GET and worker routes | F | CI |
| S12 | A retrieval completing after a workspace switch never appears in the new workspace's index | C | namespace negative test |
| S13 | Fresh pairing leaves the pairing UI after durable `paired`, and workspace routing returns at `ingress-routable`, independent of full reconciliation | startup | phase trace + physical-device smoke |
| S14 | A stale room with no answerer fails by typed availability state before the generic 30 s ceiling | startup | deployed-signaling negative smoke |
| S15 | Settled idle launches no workspace-wide panel/worker compile and remains within measured process-tree memory/child budgets | startup | supervisor process telemetry |
| S16 | The mobile provisioning scenario cannot pass without a connected desktop provider and successful structured provision + verify results | F | false-pass regression fixture |
| S17 | A crash between `paired` and `routed` resumes from the durable phase record without re-pairing | startup | kill/relaunch smoke (R26) |
| S18 | Cold-open regression from store population is bounded and stated: time-to-interactive, JS-thread responsiveness, peak memory, added bridge crossings | C | cold-load budget (R40) |
| S19 | Phase E closes with a written decision: a pre-registered threshold, measured numbers from patched and unpatched builds, and an outcome | E | decision record |

*Struck in rev. 5 with the scope they measured: the offline-render criterion, the
representation-digest-mismatch criterion, the resumable-representation-retrieval
criterion, the cross-platform canonicalization-fixture criterion, and the
cold-miss verify-then-serve latency bound.*

---

## 9. Behaviour-change register

| Change | Phase | Consequence |
| --- | --- | --- |
| Managed panels use the WebView HTTP cache | A | Stale panel shells become possible if any artifact is served without correct cache headers. The `no-store` entry document is load-bearing until B1; it gets a regression test. |
| Asset cache survives backgrounding | A/C | Higher resident disk, byte-capped. |
| The panel entry document becomes immutable per `buildKey` | B | Volatile launch state moves into the injected bootstrap. Anything that relied on a per-request dynamic HTML entry must be identified first. |
| *(if Phase E lands)* A patched `react-native-webrtc`, negotiated as a required capability | E | Maintenance on a fast-moving dependency, re-reviewed on every upgrade; the patch must preserve and prove the 16 KiB message-size constraint. Builds without support stay on the prior architecture by design. |
| A vendored patch to `react-native-tcp-socket` adds `writeStoredAsset` | C | Maintenance on a third-party module; native gains a body-transfer path validated by opaque handle. Without it the durable store is a regression, so this is not optional. |
| Cold opens get slower before Phase E | C | Store population adds a JS→native base64 path per chunk. Bounded and stated by S18, not hidden behind warm-open wins. |
| **The stored mobile credential schema is replaced** | startup | `schemaVersion: 3` → a `phase`-discriminated union (R26). One atomic migration; a phase-less record is invalid rather than upgraded. Prerequisite for the `paired` checkpoint. |
| **Desktop's dynamic asset forwarding is deleted** | B | Panel code that raw-`fetch`es worker routes or POSTs to the loopback origin works on desktop-remote today and will stop. It must move to `gatewayFetch`, which already tunnels on both platforms. Requires the panel audit that opens Phase B. Fixes an existing desktop/mobile portability difference. |
| Durable artifacts move out of the purgeable cache directory | C | Real, non-reclaimable device storage with an explicit backup policy. |
| Launch paints from durable local state before reconciling | D | UI shows locally-known state labelled reconciling; it must never be mistaken for current authority. |
| Reconnect dials both pipes concurrently | startup | Matches desktop. Credential persistence becomes single-writer as insurance; first pairing keeps its ordering. |
| Profile / host-target check leave the critical path | startup | UI may render before profile data lands; approval-required becomes a UI state. |
| WebViews no longer blanket-reload on recovery | recovery | Identity changes must be correctly detected — the condition `needsMobilePanelMaterialization` already owns. |
| Panel session opens at materialization | recovery | Sessions and grants gain lease-bound lifetime; a leak burns one-shot grants. |
| Launch verification trusts the app sandbox, declared in code | bundle | Decided: the fast path catches corruption/truncation/staleness, not tampering. Full verification on write, path confinement, and full re-hash on disagreement all remain. Void if the bundle location ever becomes shared or externally writable. |
| Pairing completes before full workspace reconciliation | startup | The UI gains explicit preparing/failed/retry workspace states; credential persistence resumes between monotonic phases. |
| `routeWorkspace` waits for ingress readiness only | startup | Child startup publishes ingress readiness independently and exposes no management RPC before authentication is ready. |
| Stale signaling rooms fail from answerer presence state | startup | Signaling gains typed peer availability tied to room/boot identity; the 30 s ceiling remains only as a final bound. |
| Workspace panel/worker compilation stays lazy | startup | First use may pay a focused compile; speculative whole-workspace memory and CPU disappear. Future bounded prefetch requires measurements. |
| Agentic mobile pass/fail comes from structured harness results | F | Natural-language completion cannot rescue missing provider/provision/verify evidence; old false positives become failures. |

## 10. Deletions register

| What | Where | Replaced by |
| --- | --- | --- |
| `cacheEnabled={!managed}` / `LOAD_NO_CACHE` | `PanelWebView.tsx:1178` | T1 enabled for all panels (A) |
| `trimMemory()` on background | `useAppLifecycle.ts:72` | `memoryWarning` only (A) |
| Duplicate `syncRuntimeLeases()` | `shellClient.ts:1116` | The one in `MobilePanels.init` (A) |
| Three-writes-per-chunk framing | `panelAssetFacade.ts:568-570` | One coalesced write per chunk (A) |
| `MobileAssetMemoryCache` (256 MiB Hermes LRU) | `panelAssetFacade.ts:125` | The durable native store (C) — deleted outright, not shrunk |
| `panels.refresh()` in `MainScreen` and `useAppLifecycle` | `MainScreen.tsx:938`, `useAppLifecycle.ts:56` | Single recovery owner |
| Unconditional managed-WebView reload | `MainScreen.tsx:325` | Identity/buildKey-conditional reload |
| Unconditional bundle re-stream | `bundleDelivery.ts:308` | `activeBundlePathIfMatches` short-circuit |
| `prewarmWorkspaceBuilds()` post-ready invocation/API | `src/server/index.ts`, `src/server/buildV2/index.ts` | Lazy focused compilation under demand; manifest indexing for cold authority work (R15) |
| One late bootstrap `ready` threshold as the route/pairing gate | `src/server/hubServer.ts`, fresh mobile pairing | `paired` → `ingress-routable` → `shell-ready` → `reconciled` lifecycle |
| Completion-report-only mobile scenario validation | mobile system-test validator | Provider preflight + successful structured provision/verify evidence |
| The "mobile has no filesystem" rationale | `panelAssetFacade.ts:22` | Corrected docblock (X3) |
| *(rev. 1)* The JS-produced native authorization table | — | Manifest-first resolution (P6, R3) |
| *(rev. 1)* Phase A's keep-alive HTTP parser | — | Dropped as unjustified complexity (R12) |
| *(rev. 1)* Routing large panel RPC bodies through the asset origin | — | Authenticated panel session, or a separate authenticated native channel (R6) |
| *(rev. 1)* Phase E's silent fallback to the JS bulk path | — | Negotiated required capability, fail visibly (R7) |
| Desktop's non-GET body forwarding and worker-route admission | `src/node/panelAssets/panelAssetFacade.ts:322-330` | The authenticated bridge, where `gatewayFetch` already routes it on both platforms (P6, R19) |
| *(rev. 2)* Ambient-workspace native store operations | — | Explicit namespace captured in the write handle (C1, R18) |
| *(rev. 2)* The compensating-release path for concurrent materialization | — | The atomic server operation, or the present ordering (§6.5, R25) |
| *(rev. 2)* Separate desktop dynamic-forwarding conformance tests | — | One suite, because there is one contract (F, R19) |
| *(rev. 4)* The artifact-manifest surface, dual representation identities, `fetchArtifactRepresentation`, the build-store derivative service, and route canonicalization (B6) | — | **Struck in rev. 5** — all of it existed to serve background prefetch, which is punted. Digest-on-write needs no declared identity |
| *(rev. 4)* Background prefetch, pinning, and the sync settings surface | — | **Struck in rev. 5.** A durable store makes warm opens free; prefetch only made *first* opens free |
| *(rev. 4)* The native loopback server (iOS `NWListener` / Android `ServerSocket`) | — | **Struck in rev. 5.** The JS server stays; the durable store goes behind it |
| *(rev. 4)* Offline rendering (D2) and its non-authoritative runtime contract | — | **Struck in rev. 5** as a goal |
| `StoredShellCredential` `schemaVersion: 3` (both-pairings-required) | `packages/mobile-webrtc/src/storedCredential.ts:28-44` | `StoredMobileConnection` phase union, `schemaVersion: 4` (R26) |
| *(rev. 3)* "Opens with the network off" as a committed target | §0 | Zero pipe bytes for a panel whose code is already stored; offline struck as a goal (R27, rev. 5) |
| *(rev. 3)* "Speed, then maintainability, then security" as an ordering | P3 | Security invariants as constraints, speed/maintainability ordered within them (R33) |

## 11. Explicitly not doing

- **Raising the 16 KiB data-channel chunk size.** A correctness constraint (C5).
- **Adding more in-memory caching.** More Hermes-resident bytes is the problem's
  shape, not its solution.
- **Tuning timeouts.** No latency in §3 is caused by a timeout value. The
  clock-bound items change because they are the wrong *mechanism*, not because
  4 s or 30 s is the wrong number. In particular, stale-room detection moves to
  answerer availability state (R14); the connect ceiling remains a safety bound.
- **Per-user isolation in the asset store.** Trusted shared environment. Index
  partitioning by server/workspace/build is *correctness* (R9), not isolation.
- **Any policy in native code.** Native owns body transfer and storage only. The
  path/GET/worker-route policy lives once, in the JS server, on both platforms
  (P6). Native receives opaque keys and handles and makes no decisions.
- **A protocol change for concurrent pipes.** Not required — §2.4 R4.
- **Background prefetch, artifact manifests, and representation protocols.**
  Struck in rev. 5. If Phase 0 later shows *first*-open latency is the dominant
  complaint after the durable store lands, prefetch returns as its own plan with
  its own evidence — not as a layer smuggled in under caching.
- **A native loopback server.** The remaining outbound base64 hop on a cache hit
  does not justify two hand-rolled HTTP implementations and a third URL
  canonicalizer. (The *inbound* hop on a cold open is a different question, and
  Phase E answers it with measurements rather than assuming either way.)
- **Offline panel rendering.** Struck as a goal; it buys a capability by adding a
  second runtime contract.

## 12. Open questions

**None on the asset-plane track.** Both audits are complete; their findings are in
Phase B, and both made the work smaller rather than larger:

| Was | Result |
| --- | --- |
| What depends on the entry document being dynamic? | **Nothing.** The served body is a pure function of the HTML artifact, the build key, and the artifact path set (`panelHttpServer.ts:774-789`, `:967`); `contextId`/`ref`/`buildKey` select the build, they do not template it. The `no-store` exists because the entry was designed as a mutable pointer — and `buildPanelUrl` already pins a validated `buildKey` in the query (`panelFactory.ts:121-132`), so that indirection is already resolved client-side. B1 shrinks to a cache-control change plus a `(source, buildKey)` cache key. |
| Which panels raw-`fetch` the loopback origin? | **None.** No `fetch("/_r/w/…")` in `workspace/`, no relative `fetch("/…")` in any panel or app outside `node_modules`, no `XMLHttpRequest`/`EventSource` against the origin. Desktop's dynamic-forwarding deletion has no callers to migrate. Kept honest by the loud 405/403 it already returns, since a grep cannot see a dynamically-built URL. |

Startup-track questions (owner: the readiness lifecycle work):

1. **Is there a host-target-changed event?** If yes, N5's poll loop disappears
   entirely rather than merely moving off the paint path.
2. **Exact `ingress-routable` contract.** The smallest child startup set that can
   authenticate a workspace pipe and publish a stable reach without implicitly
   pulling extension reconciliation back into the gate.
3. **Answerer availability lifetime.** How signaling presence is leased, tied to
   server boot identity, and failed closed across DO hibernation without turning
   the signaling service into an authority or data relay.
4. **Resource budgets.** Phase 0 must set process-tree high-water and idle child
   budgets before any bounded prewarm is considered; the one-run RSS values in
   §2.5 are evidence of the defect, not thresholds chosen to fit it.

The earlier traceability question is closed for the follow-up exact runs by
`docs/measurements/mobile-physical-baseline-2026-08-10.md`; the older signaling
samples remain explicitly labelled as pre-artifact diagnostics.

The implementation follow-up also closed the principal recovery proof. An
Android run paired through the headless server, rendered the selected panel,
cold-started the persisted app, restarted the named server workspace, and
rendered again. Both recovery legs recorded zero panel-asset pipe misses; the
server-restart entry document came directly from the native durable store. The
smoke owns and cleans its emulator/server resources, and the Electron launcher
now gives its application a bounded graceful-shutdown window so an interrupted
run cannot strand the Electron-owned hub.

*Not open, though they look it:* the `writeStoredAsset` patch has a symmetric
surface on both platforms (`TcpSocketModule.java` and `ios/TcpSockets.m` both
export `write`/`listen`), so it is two implementations of one known method rather
than an unknown; per-platform completion and backpressure semantics are a design
detail of that task. Desktop needs no equivalent — Node streams a file to a
socket natively.

*Closed by the rev. 5 scope cut: T2's fate (deleted outright), the native-server
implementation surface (no native server), whether D2 is wanted (struck),
`contextId`'s role in route identity (no canonical route protocol), and manifest
scope (no manifests).*

### Decided (kept for the trail)

| Was | Decision |
| --- | --- |
| Prefetch policy — how much does the device pull unasked? | Superseded: **prefetch is punted entirely** (rev. 5). Nothing is pulled unasked, so there is no policy and no setting. |
| Manifest scope — per-`buildKey` or workspace-wide? | Superseded: **there are no manifests** (rev. 5). |
| Launch verification — declared sandbox trust or authenticated activation record? | **Declared sandbox trust**, stated in those words in the code, with full verification on write, path confinement, and full re-hash on disagreement retained. Void if the bundle location ever becomes shared or externally writable. See §6.5. |

# Host cache identity follows the installed graph

Identical Host source/lockfiles can resolve different nested dependencies (actual AWS4.11.3 vs4.12.1). Host bundles installed JavaScript, so a source/lock-only receipt can accept foreign bundles. Fingerprints now include the actual canonical installed package graph, preserving package versions and physical-owner resolution topology while removing physical relocation addresses from identity.

## Mechanism inventory

| Producer/consumer | Ownership and change |
|---|---|
| build.mjs192–198,302–308 and worker/CLI configurations334–492 | bundle:true with explicit limited externals consumes installed libraries. Both full desktop build823–904 and source-server prerequisites1012–1059 capture before/after and reuse computeHostBuildFingerprint. Shared fingerprint now includes installed graph plus Node/platform/architecture. |
| scripts/host-build-fingerprint.mjs109+ | Source+lock+mode fold lacked installed resolution. Adds one shared canonical graph capture; receipt shape unchanged, hash-domain version changed. Source-input tree callback excludes generated dist/node_modules so building its own outputs cannot invalidate its input snapshot. |
| scripts/infrastructure-package-cache.mjs165–183,281–310 | Previously source+lock+toolchain only. commonInputDigest includes all actual root/package dependency realms; cache schema bumped3. Explicit toolchainDigest cannot bypass installed graph. SQLite build lock remains synchronous. |
| scripts/lib/installed-package-graph.mjs and effectiveVersion.ts | Extracts the existing installed-package-graph/2 traversal into one generator with synchronous build and bounded asynchronous workspace drivers. Physical package interning, cycles, Node owner-resolved lookup, missing optional edges and platform-gated exclusion preserved. Runtime callback retains session.tree/io policy. |
| scripts/host-build-generations.mjs284–399,466–489 | Generation directory/pointer/completion validation consumes fingerprint, never computes separate source identity. Existing exact receipt/payload validation retained. |
| scripts/ci-host-build-inputs.mjs115–145 | Calls shared infrastructure inspection and Host fingerprint before accepting restored cache/generation. No separate bypass. |
| scripts/ci-quality-inputs.mjs24–32 | Consumes shared infrastructure plan and receipt. Inherits installed identity. |
| scripts/prepare-development-workspace-release.mjs44–56; src/dev/productRelease.ts84–85 | Compare expected shared Host fingerprint against sealed generation receipt; inherit new graph. |
| scripts/ensure-host-build.mjs3–12; src/dev/runInstance.ts281,709; scripts/cli/lib/pair-server.mjs256; desktop-pairing-smoke.mjs2492; cli/mobile-smoke.mjs2605 | Invoke canonical build entry, no parallel source-key implementation. |
| scripts/build-infrastructure-packages.mjs5; scripts/type-check-userland.ts96 | Call shared infrastructure build cache; inherit identity. |
| scripts/server-runtime-artifacts.mjs61; build-artifact-contracts.mjs; clean-host-build-output.mjs; package-desktop | Transport, invalidate, or package completion receipts. Do not decide source equivalence independently. |
| Userland workspace cache/release identities | effectiveVersion's existing canonical graph remains authoritative via shared async driver. Existing exact workspace source/build/catalog identities are unchanged by Host-specific source tree policy. No active V16 source/release byte changes. |

No unsafe opt-out: a cache whose consumed inputs differ cannot truthfully be treated as matching. Explicit source mode/toolchain choices remain inputs. This is a future Host successor, not a reason to block valid current collection.

## Validation

Targeted regressions cover same-source/same-lock nested version changes, relocation of absolute package links, shared sync/async graph identity with cycles, infrastructure cache invalidation, and existing generation custody checks. Actual Node run21/21passed under cap0.5GiB/reserve7.5GiB,128.4MiB peak. Broader targeted Vitest qualification pending at document creation; actual results recorded on completion.

Actual qualification: Node21/21passed (generation custody and new dependency/relocation/parity tests); infrastructure/fingerprint Vitest19/19passed; existing runtime graph/EV38/38passed with readonly V16sealed browserTransport prerequisite,315.4MiB peak under1.5GiB/reserve7.5GiB. Earlier test setup errors (missing config export/globals/explicit Host artifact root) were retained in ledger journals; they were not counted as passes. No full Host build was run or active generation changed.

The retained canonical policy hashes registry manifests/resolved topology and editable package implementation inputs. It does not claim a full payload-byte hash for manually modified same-version registry installs; this is the existing workspace graph's trust boundary, not a new content-identity claim.

Additional actual Node regressions7/7passed (`host-dependency-identity-node-20261123b`): generated local dist changes leave input identity stable; editable source changes invalidate it; same-version nested-to-hoisted rebinding changes singleton topology. Together80distinct targeted tests passed (23Node +19infrastructure/fingerprint +38runtimegraph).

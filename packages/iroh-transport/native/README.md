# Iroh native lifecycle repairs

## Request-owned dial cancellation

The reviewed patch additionally introduces `Endpoint.beginConnect(addr, alpn)`
and a native `DialAttempt` with `connect()` and `cancel()`. Creating the handle
precedes address resolution and connection establishment. Cancellation drops
the complete owned dial future and joins it before returning; it does not close
the shared endpoint or its healthy connections. Endpoint closure also settles
the pending dial. The Node and UniFFI implementations share this contract.

The real QUIC regression holds a relay unresponsive, cancels repeated dials,
and verifies that another connection still transfers data. It also checks
cancellation before connect, single consumption, and endpoint closure.

This API is **not shipped** by the currently pinned `1.1.0-cancel.2` release.
The application still needs the matching published release before its endpoint
generation owner can use this contract. The Node package builder regenerates
JavaScript and declarations with the source's locked NAPI compiler, produces
matching root and platform tarballs, and installs both into a fresh consumer.
It checks CommonJS and ESM exports and typechecks the dial API. CI retains
the root package, platform package, tarballs, and their binding hashes.
Publishing requires those matching Node packages and the generated Kotlin/Swift
bindings alongside the native artifacts. Main-branch repair builds now stamp
all five Node targets, the Android AAR, and the Apple archive with the matching
`1.1.0-cancel.3` candidate version. The workflow uploads these candidates and
verifies the Node package set; it does not publish them or change application
dependency pins. Use the receipts from one successful complete workflow run
when reviewing the release, rather than combining binaries from different runs.
Do not add feature detection, cast an unsupported API, or substitute the proof
binary into production to bypass that dependency boundary.

## Endpoint readiness cancellation

The previous `1.1.0-cancel.1` binaries repair stream cancellation but still
leave `Endpoint.online()` pending after endpoint closure. A JavaScript timeout
does not cancel that native wait; replacing endpoints after a relay timeout can
therefore accumulate native tasks and prevent clean process exit.

The reviewed source patch now races readiness against Iroh's existing
`Endpoint.closed()` future inside Rust, in both Node and UniFFI. Closure wins
if both are ready. The losing readiness future is dropped before returning an
error to the caller. This adds no timer or application cancellation channel.
Node retains `Promise<void>` (with rejection on close); regenerated UniFFI
bindings must include the new fallible result when building mobile artifacts.

Server ingress now lets Iroh reconnect the same endpoint through an outage;
elapsed time alone does not retire it. Binding failures still fail startup.
The native endpoint regression covers concurrent readiness waits and calls
after closure. The owned relay acceptance test additionally holds a real relay
connection unresponsive for 16 seconds, restores it, and requires recovery
without rebinding and natural process exit:

```sh
NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/repaired/iroh.node \
  pnpm exec tsx scripts/test-iroh-readiness.ts
```

The desktop and Android pins now select the published `1.1.0-cancel.2` repair.
Apple adoption still requires a matching generated Swift package as well as
the XCFramework; the app's Apple dependency remains upstream. Never overwrite
either published repair version or substitute a local development binary for
the shipping artifact.

The Apple builder retains the generated `IrohLib.swift` alongside the archive
and records both hashes in its receipt. It also extracts that retained archive
into a fresh Swift consumer, installs the matching generated wrapper, and runs
upstream Swift tests plus endpoint-readiness and owned dial cancellation
regressions. This checks the package consumer boundary as well as Rust compilation. CI uploads that binding too: publishing
the archive without its matching Swift source loses the generated API and FFI
checksums. A release must install that source in the Swift package and update
its binary target to the actual published archive URL and checksum. Retaining
these inputs alone does not publish or adopt the package.

## Stream cancellation

The pinned Iroh FFI 1.1.0 binding holds each stream mutex across network waits.
Consequently `RecvStream.stop()` cannot interrupt a pending read, and
`SendStream.reset()` cannot interrupt a flow-controlled write. This is a native
ownership defect. Closing the shared connection would also break unrelated
requests.

`source.json` pins the upstream commit, original and patched Cargo lock hashes,
and reviewed patch digest. The patch changes both Node and UniFFI Rust wrappers:
terminal stop/reset cancellation releases pending data operations before taking
the stream mutex; later/queued data operations reject. The native QUIC control
operation still runs on that stream. `stopped()` releases its mutex before
waiting, and local reset also releases its pending observer. `receivedReset()`
returns no peer reset after local stop, matching the underlying receive API.
Read/write ordering remains serialized. Partial data from an interrupted
operation is discarded because the corresponding stream half is terminal.

The only dependency change makes already-locked `tokio-util` a direct dependency
of the two bindings. There is no Rust dependency version update, application cancellation channel,
or JavaScript transport workaround.
The reviewed patch also corrects the Node package-manager declaration to
Yarn 4.4.0, matching its checked-in Yarn executable and lockfile. Node package
builds use an immutable install and private package caches.

`Connection.beginOpenBi()` returns a `BiStreamOpenAttempt` that owns the wait
for peer stream credit. Its `cancel()` interrupts and joins that wait without
closing the shared connection. An attempt is consumed once; cancellation before
opening is terminal. After opening succeeds, the returned stream belongs to its
caller and cancelling the attempt leaves that stream usable. Connection closure
propagates the original native opening failure. Both Node and UniFFI expose this
contract. The regression exhausts real QUIC stream credit and checks repeated
cancellation, connection closure, and continued traffic on sibling streams.

## Reproduce locally

Requires Git, Node 20.3+, Rust 1.91+, a native C toolchain, and network access to
fetch the pinned source/dependencies. From the host checkout:

```sh
node packages/iroh-transport/native/build-and-verify.mjs /path/on/disk/iroh-cancellation-proof
```

The output directory must be new. The script checks source/patch/lock digests,
builds the native Node library with Cargo's `dev` profile, checks UniFFI, and runs
upstream endpoint tests plus real QUIC cancellation tests. Pass `release` as the
second argument for upstream's release profile. The receipt records compiler,
platform, binary digest and validation. No application dependency is installed
or replaced. The output source tree is also the exact patched input for
upstream's Android/Apple build tasks.

The regression exercises all receive methods, reset observers, flow-controlled
writes, queued operations, invalid control codes, and continued communication
on another stream of the same connection. The original published binary fails
the pending cancellation cases. For a deliberately selected host acceptance run,
the official Node loader supports `NAPI_RS_NATIVE_LIBRARY_PATH` pointing at the
receipt's artifact. This environment variable is a test input, not a shipping
configuration.

The Host retains the same critical receive-cancellation contract in its native
transport fixture. Run it against the repaired artifact without changing any
installed package:

```sh
NAPI_RS_NATIVE_LIBRARY_PATH=/tmp/iroh-cancellation-proof/iroh.node \
  pnpm vitest run packages/iroh-transport/src/nodeFixture.test.ts
```

Omit the environment variable to test the installed production binding. The
`local receive cancellation settles a pending read without peer data` case must
pass there before the production repair is considered shipped. It asserts both
local read settlement and the peer's STOP_SENDING code; fixture cleanup closes
the owned endpoints even if the cancellation assertion fails.

The defect is also observable one layer up, without any native fixture. In
`packages/rpc`, a streaming request whose peer sends no response head must reset
its own request-owned stream so the peer observes STOP_SENDING; the pending
`readFrame` on that stream makes `RecvStream.stop()` block instead, the peer
never advances, and a later sibling request starves until its default head
timeout. Both cases were verified together against a locally built repair on
linux-x64 (dev and release profiles):

```sh
NAPI_RS_NATIVE_LIBRARY_PATH=/tmp/iroh-cancellation-proof/iroh.node \
  pnpm vitest run --config vitest.host.config.ts \
  packages/iroh-transport/src/nodeFixture.test.ts \
  packages/rpc/src/transports/irohClient.test.ts
```

Against the installed 1.1.0 binding both fail; against the repair both pass.

## Release requirement

This directory is reproducible repair input, not a replacement release set.
`src/releaseSet.ts` and production dependency pins remain unchanged. Shipping
requires an immutable upstream or reviewed fork release, built from these
reviewed source inputs using upstream's release tooling, and then one coherent
update of npm/Maven/Swift pins and their checksums. Do not overwrite published
1.1.0 artifacts or conceal a local binary under `node_modules`.

The current pinned Node distribution has eleven native packages: Android ARMv7
and ARM64; macOS ARM64; Linux ARMv7, ARM64 and x64 with GNU and musl variants;
and Windows x64 and ARM64. The mobile Android AAR contains armeabi-v7a,
arm64-v8a, x86 and x86_64. Its companion Kotlin/JVM JAR is also part of the
Maven release and currently carries Linux x64/ARM64, macOS ARM64 and Windows x64
UniFFI libraries. Apple's build uses five targets: ARM64 iOS device,
ARM64 and x64 iOS simulator, ARM64 macOS, and ARM64 Mac Catalyst (the two
simulator targets become one combined XCFramework slice). Android needs its NDK
and cargo-ndk; Apple needs macOS/Xcode. Upstream's `Makefile.toml`,
`make_swift.sh`, and release workflows own those builds and package validation.
A local Linux binary or a single emulator ABI proves only that acceptance
platform; it cannot stand in for the complete published release.

Upstream was rechecked on 2026-09-07: npm, Maven and Swift still select
[1.1.0](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.1.0).
The unreleased [change to `SendStream.stopped()`](https://github.com/n0-computer/iroh-ffi/commit/b733577fbb1bedc2595ab8fb5597f4b570896ac7)
addresses one mutex wait. It does not cancel pending reads or writes: both
[Node](https://github.com/n0-computer/iroh-ffi/blob/3103bf5295be6d50c5272ff7a426e9b539f3f587/iroh-js/src/endpoint.rs)
and [UniFFI](https://github.com/n0-computer/iroh-ffi/blob/3103bf5295be6d50c5272ff7a426e9b539f3f587/src/endpoint.rs)
still hold their stream mutex across those waits. That upstream change is not
a substitute for this repair or an available coherent dependency release.

## Reviewed fork release

`build-platform-package.mjs` regenerates a root Node API and one matching native
platform package from the reviewed inputs. The workflow builds the five desktop
targets enforced by `check-electron-package-boundary.mjs`. Each target installs
its actual root and platform tarballs in a fresh consumer, checks CommonJS and
ESM exports, typechecks the generated dial and stream-opening APIs, and runs the endpoint,
stream, dial, and stream-opening cancellation suites through the installed loader. The final workflow
gate requires identical generated JavaScript and declarations across all five
targets, matching source receipts, and exactly matching platform versions.

```sh
node packages/iroh-transport/native/build-platform-package.mjs OUT \
  --target x86_64-unknown-linux-gnu --version 1.1.0-cancel.3 --scope @panticonic
```

CI retains the root package, platform package, tarballs, and receipt. Publish
one shared root tarball and all five matching platform tarballs only after the
coherence gate passes. The root package selects those platform packages through
exact optional dependency versions. Adopting the new API requires switching the
root dependency too: the currently pinned upstream root loader and declarations
do not expose `DialAttempt` or `BiStreamOpenAttempt`. Then regenerate `src/releaseSet.ts` integrities and
`scripts/cli/lib/connect-grammar.generated.mjs` through the ordinary release
process. Do not land pins before the packages exist or overwrite a published
version.

This pipeline covers the desktop Node bindings only. The Android AAR, its
Kotlin/JVM JAR, the Apple XCFramework, and the musl and ARMv7 Node targets are
still governed by the release requirement above and by upstream's Android and
Apple build tooling. Until those are built and pinned together, the fork is
incomplete and `IROH_RELEASE_SET` must not be repointed.

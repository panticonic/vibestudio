# Iroh native stream cancellation repair

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
of the two bindings. There is no Rust dependency version update, foreign API
change, application cancellation channel, or JavaScript transport workaround.

## Reproduce locally

Requires Git, Node 20.3+, Rust 1.91+, a native C toolchain, and network access to
fetch the pinned source/dependencies. From the host checkout:

```sh
node packages/iroh-transport/native/build-and-verify.mjs /tmp/iroh-cancellation-proof
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

`build-platform-package.mjs` builds one publishable replacement for an upstream
`@number0/iroh-<platform>` package from the same reviewed inputs, and
`.github/workflows/iroh-native-repair.yml` runs it across the five desktop
targets `check-electron-package-boundary.mjs` enforces. Only the native artifact
differs: `@number0/iroh` requires its platform package *by name* and returns
whatever that package exports, so the JavaScript, types, and API surface stay
upstream's. The emitted manifest reproduces upstream's shape exactly apart from
name and version.

```sh
node packages/iroh-transport/native/build-platform-package.mjs OUT \
  --target x86_64-unknown-linux-gnu --version 1.1.0-cancel.1 --scope @panticonic
```

Matching this repository's npm convention, CI builds and uploads; a developer
publishes. After every platform package is published, the cutover is one
coherent change: alias each upstream platform name under root `pnpm.overrides`
(`"@number0/iroh-linux-x64-gnu": "npm:@panticonic/iroh-linux-x64-gnu@<version>"`,
and so on), then regenerate `src/releaseSet.ts` integrities and
`scripts/cli/lib/connect-grammar.generated.mjs`. Do not land the overrides
before publication: an alias to an unpublished version breaks installation for
everyone. The napi loader's version check is opt-in through
`NAPI_RS_ENFORCE_VERSION_CHECK`, which this repository does not set, so a
provenance-bearing version such as `1.1.0-cancel.1` is safe.

This pipeline covers the desktop Node bindings only. The Android AAR, its
Kotlin/JVM JAR, the Apple XCFramework, and the musl and ARMv7 Node targets are
still governed by the release requirement above and by upstream's Android and
Apple build tooling. Until those are built and pinned together, the fork is
incomplete and `IROH_RELEASE_SET` must not be repointed.

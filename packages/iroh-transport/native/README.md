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

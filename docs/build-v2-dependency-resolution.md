# Build V2 dependency resolution

The canonical authoring contract lives in the Base workspace development skill
at `skills/workspace-dev/DEPENDENCIES.md`. It documents overrides, direct and
transitive patches, owner adapters, derived extension installs, cache and recipe
identity, strict failures, and validation.

This placement is intentional: dependency resolution is a live userland Build
V2 capability, not root package-manager or host installer policy.

The Host nevertheless publishes a reusable dependency realm for canonical Base
builds. `pnpm check:userland-dependencies` proves that the Host's published
range is a subset of every matching Base runtime range; overlap alone is not
enough because a fresh npm install could choose a version Base rejects. A build
may reuse that realm only when one package-owned node_modules root satisfies the
complete closure and the closure has no overrides or patches.

The same check treats the selected Electron app and every `initPanels` entry as
a stronger product boundary: every dependency in those complete closures must
be a direct Host dependency, and the closures may not carry an override or
patch that requires an isolated realm. Depending on incidental package-manager
hoisting is insufficient. This prevents a fresh server installation from
running a second npm install while preparing the first visible desktop surface.

Reuse does not relax resolution. Bare imports are resolved exclusively through
the prepared realm, never through node_modules directories above materialized
workspace source. The build key fingerprints the exact installed package
manifests and nesting, and a resolver or dependency-realm change increments the
global build-cache generation. This keeps the no-install cold path without
making a user's home-directory packages an implicit build input.

## Cold and warm build policy

An empty state directory and a populated state directory are separate supported
performance cases. The empty-state path may install a dependency realm and
compile each requested unit once; the warm path must reuse the resulting
content-addressed artifacts without rebuilding them. Both paths are exercised
through isolated developer instances rather than by deleting or reusing a
person's normal instance.

Build V2 uses two build lanes by default. An individual esbuild and TypeScript
fold already uses the machine in parallel, so machine-wide concurrency makes
each fold slower; a bounded pair still lets the selected shell and initial panel
advance together. Work waiting for a lane is explicitly classified:
interactive requests precede background preparation.
`VIBESTUDIO_MAX_CONCURRENT_BUILDS` remains an operator override for
throughput-oriented batch environments.

Source maps are also an explicit unit cost. Extensions retain maps because they
run as host-side code, while panel, app, and worker manifests opt in with
`vibestudio.sourcemap: true`. In the representative shell workspace, making
runtime maps opt-in reduced the initial chat panel artifact set from 368 files
and 35.4 MB to 187 files and 7.7 MB. It preserves the runtime payload while
removing debugger-only output from cold compilation, hashing, persistence, and
cache validation.

## Startup preparation and transfer closure

Remote readiness is a bounded product contract, not workspace-wide prewarming.
After declarations are reconciled, the server prepares the selected Electron
shell artifact and the deduplicated panel sources named by `initPanels`. It uses
the ordinary runtime-image cache path and does not create panels or execute
workspace code. A pairing link is published only after that finite set is
ready. All other panels, workers, extensions, and optional app features remain
lazy.

Apps can declare package-root-relative `vibestudio.app.startupModules`. These
modules stay dynamically executed, but their emitted static closures are added
to the initial artifact bundle. This removes a request-by-request WebRTC
waterfall without eagerly evaluating optional code. The Base shell declares its
normal `App` module; feature toolchains below it remain lazy.

On a completely empty isolated desktop-pairing state, this reduced the shell
app's artifact HTTP request count to five. In the same smoke environment,
Electron startup fell from 8.208 s to 7.227 s and desktop mount from 4.644 s to
3.650 s. Warm verified reuse of the representative panel artifact completed in
about 0.31 s with the same build key.

A later empty-state packaged-server profile exposed a distinct 44.97 s chat
path: only 1.48 s was esbuild, while 42.92 s installed a dependency realm
because four Base dependencies were absent from Host. Publishing the complete
startup closure reduced dependency preparation to 2 ms and the chat build to
1.85 s in the same smoke. With two lanes, the paired shell and panel reached the
initial-panel readiness boundary in 4.25–4.56 s in the sampled cold runs,
compared with 4.80–5.18 s through one lane. These measurements are diagnostic,
not fixed budgets; the enforced guarantees are that canonical startup performs
no package-manager install, cold preparation occurs before readiness, and the
next launch becomes verified artifact reuse.

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

Interactive Build V2 defaults to three concurrent build lanes. Each unit
uses native compiler processes and TypeScript, package-resolution, and hashing
work. The admission limit bounds their aggregate resource use while allowing
interactive requests, required startup work, and speculative preparation to
make progress. Some internal stages share owners and serialize; increasing
admission helps only when those dependency edges permit independent work.
The scheduler prioritizes interactive requests over background preparation.
Exhaustive template release preparation is throughput-oriented batch work. Its
owning orchestrator assigns that single producer a budget from the process CPU
allowance and host memory, reserves capacity for the supervisor and native
executors, and caps automatic admission at eight lanes. This does not increase
the separate three-lane budgets of live interactive workspaces.
`VIBESTUDIO_MAX_CONCURRENT_BUILDS` remains the authoritative process-local
override for a runner with a measured resource envelope. More admission does not
duplicate identical in-flight build keys, which Build V2 coalesces.

Installed template preparation submits independent roles and runtime units
concurrently through one operation-owned `BuildProcessOwner`, then joins every
outcome before retiring the builder and the three role-specific native
executors. The producer's one admission budget is therefore the resource edge
for the complete batch; adding another role loop or builder path would duplicate
work and escape that budget.

Fresh-install verification overlaps six independent source requests within each
selected workspace through one installed CLI client connection, preserving the
ordinary `build.getBuild` path and exact artifact identity and creation-time
checks. Separate CLI processes sharing an Iroh endpoint identity contend for
that identity's lock; admitting more processes does not parallelize those calls.
The verifier instead multiplexes requests on the existing authenticated client,
joins every request, retains all failures, and closes that client before
switching the shared CLI profile to another workspace.

A restored extension's runtime dependencies must exist in its own build-local
`node_modules` projection. Packages reachable only through a host ancestor do
not establish readiness for the isolated extension. Owned package-store symlinks
remain valid; an absent or incomplete projection follows the same installation
and materialization path as a cold build.

Prepared compiler inputs have stable virtual identities relative to their owned
source or dependency roots. Temporary physical roots remain resolution and
diagnostic coordinates, rather than becoming part of executable bytes. Identical
immutable inputs must produce identical output when materialized in a new root.

Parallelism must avoid multiplying shared work. A protected-main publication
checks its roots as one operation: authenticated immutable tree reads are shared
within that operation, with bounded storage concurrency, while every root keeps
its own completeness and depth proof. The operation joins all checks before
approval or ref mutation. Derived-cache process-liveness probes run outside
SQLite writer transactions; reclamation then compares the observed owner inside
a short transaction. A failed lease release retains ownership until deletion
commits, so cleanup can still retire the lease.

Source maps are also an explicit unit cost. Extensions retain maps because they
run as host-side code, while panel, app, and worker manifests opt in with
`vibestudio.sourcemap: true`. In the representative shell workspace, making
runtime maps opt-in reduced the initial chat panel artifact set from 368 files
and 35.4 MB to 187 files and 7.7 MB. It preserves the runtime payload while
removing debugger-only output from cold compilation, hashing, persistence, and
cache validation.

## Startup preparation and transfer closure

Remote readiness is a bounded product contract, not workspace-wide prewarming.
After declarations are reconciled, the server prepares the default client of
the host named by `--require-client-ready <host>` and the deduplicated panel
sources named by `initPanels`. It uses the ordinary runtime-image cache path and
does not create panels or execute workspace code. A pairing link is published
only after that finite set is ready. All other panels, workers, extensions, and
optional client features remain lazy.

The measurements below predate the client model: they were taken when the
desktop shell declared its startup modules so their static closures joined the
initial artifact bundle. Clients no longer declare startup modules; a client's
build is one verified artifact set the host caches by integrity.

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
compared with 4.80–5.18 s through one lane. That sample used the then-current
two-lane configuration; it does not describe the present default. These
measurements are diagnostic, not fixed budgets; the enforced guarantees are
that canonical startup performs no package-manager install, cold preparation
occurs before readiness, and the next launch becomes verified artifact reuse.

Host-owned template tests use the same semantic package graph and dependency
projection. Source-only Host SDK imports resolve from their package export maps,
including imports made by external template checkouts. TypeScript path mappings
remain exact unless they declare a wildcard; a bare package mapping does not
capture its subpaths. Adding an SDK export therefore does not require a duplicate
Vitest alias. Explicit source and npm export aliases also keep this exact-match
behavior, so a package root cannot accidentally expose an undeclared private
subpath.

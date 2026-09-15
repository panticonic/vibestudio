# Hardened Runtime Integration: SES, LavaMoat lessons, and Endo lessons

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. The isolation mechanism choices and phase sequence below are superseded. Findings and adversarial cases remain inputs to the canonical plan's runtime work.

Status: implementation plan, revision 2 (2026-07-21).

Companion to `explicit-capability-manifest-plan.md` (rev 3) and
`capability-model-redesign.md`; rollout semantics defer to
`authority-migration-plan.md` (no runtime feature flags — revertible phase commits).
The manifest plan's confinement layer names Hardened JavaScript as the runtime
mechanism that makes unrequested authority _unreachable_ rather than merely
undeclared. This document grounds that commitment in the actual execution
architecture, decides which pieces of the Hardened JS / LavaMoat / Endo stack we
adopt versus reimplement, and sequences the work.

Revision 2 corrects revision 1's central error: the existing eval path is **not** a
"hand-rolled compartment," because evaluated code retains the realm's `globalThis`
and the kernel currently installs powerful objects there. This revision states
honestly, per stage, what confinement level is actually achieved.

## 1. The execution architecture this must fit

Findings from the current codebase, which drive every decision below:

1. **Eval snippets run in the same realm as host code — with powerful globals
   reachable.** `EvalDO` (`packages/builtin/src/eval-engine/EvalDO.ts`) is the blessed
   unsafe-eval kernel: agent-written code is Sucrase-transformed to CJS
   (`workspace/packages/eval/src/transform.ts`), compiled via the workerd
   `UNSAFE_EVAL` binding (`newFunction`), and invoked directly in the DO's realm.
   Named endowment parameters shadow only their own identifiers; `globalThis` and
   every unshadowed global remain reachable. The kernel's own bootstrap
   (`ensureIsolateModuleGlobals`) currently installs `__vibestudioCompileFunction__`
   (raw compile capability), `__vibestudioRequire__` and `__vibestudioModuleMap__`
   (the _shared, cross-owner_ module map), and the lazy-import loader installs a
   further temporary global. Guest code can therefore compile arbitrary code past
   Sucrase/import validation and deadline instrumentation, and read across the
   per-object isolation, **today**. Multiple owners share one workerd isolate;
   intended tenant isolation is the per-object module map plus owner-identity
   checks — not realm separation.
2. **Endowments are otherwise explicit and named.** The eval scope receives the
   hosted runtime, `services`, `db`, `ctx`, `scope` as named function parameters
   (`evalDO.ts`, `workspace/packages/eval/src/execute.ts`), and the _intended_
   import path links through a host-controlled per-owner module map with import
   validation (`importValidation.ts`). The architecture is object-capability
   _shaped_; what is missing is a private global environment, frozen intrinsics,
   and hardened endowments.
3. **Bundling erases package boundaries.** Guest-facing library imports are esbuild
   CJS mono-bundles (`buildLibraryBundle`, `src/server/buildV2/builder.ts`); panels
   are esbuild ESM bundles. Per-package confinement cannot be applied after a
   dependency has been inlined into a flat bundle.
4. **Almost nothing is frozen.** Only the per-run `RpcClient`, execution context,
   and provenance objects are frozen today. The hosted runtime surface, module-map
   namespaces, and all shared intrinsics are guest-mutable.
5. **Panels run third-party code in the panel runtime's realm.** Each webview is a
   separate OS process, but inside it, dependency code shares intrinsics _and
   globals_ with the panel runtime: the bootstrap payload is installed on
   `globalThis.__vibestudioPanelInit` before navigation
   (`apps/headless-host/src/pageHost.ts`), and whatever holds the RPC bridge is
   reachable from any code in the realm.
6. **Workers and userland DOs already sit behind the right boundary.** Each runs in
   its own workerd isolate with explicit capability bindings served by
   `WorkerdManager`. workerd itself is the capability boundary Endo reconstructs
   inside a realm; the residual gap there is intra-unit (dependency-vs-first-party),
   not host-vs-guest.
7. **Install scripts are already allowlisted.** `package.json` pins pnpm 10 with
   `pnpm.allowedBuilds` (electron, esbuild, node-pty, node-datachannel). The
   supply-chain outcome LavaMoat's `allow-scripts` provides is substantially in
   place; only marginal deltas remain (§6).

## 2. Decision summary

| Piece                              | Verdict                                                                                                                                                                                                                               | Where                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| SES `lockdown()`                   | **Adopt.** Frozen intrinsics everywhere guest code shares a realm with anything.                                                                                                                                                      | EvalDO isolate, panel webviews, worker/DO isolates, eventually host |
| SES `harden()`                     | **Adopt, with stated carve-outs.** Capability objects crossing into guest scope are transitively frozen; deliberately mutable surfaces (`scope`, live module maps) are confined differently (§3.3).                                   | All endowment surfaces                                              |
| SES `Compartment`                  | **Do not adopt in workerd** (its evaluator cannot run there). Reconstruct its two properties — private global environment, controlled linkage — explicitly (§3.2). Adopt real Compartments where native eval exists (webviews, Node). | Eval: reimplement. Panels: later.                                   |
| Endo compartment-mapper            | **Lesson, later mechanism.** Per-package module graphs with narrowed endowments — viable in webviews, reimplemented via the module map in workerd.                                                                                    | Panels (long-term)                                                  |
| LavaMoat policy model              | **Adopt the lesson, not the tool.** Checked-in, per-package, generated-but-human-reviewed authority policy ≙ our manifest `packages:` attenuation. No esbuild integration exists; the runtime assumes SES compartments.               | Manifest plan §8                                                    |
| LavaMoat lavapack / webpack plugin | **Do not adopt.** Wrong bundler, wrong runtime assumptions.                                                                                                                                                                           | —                                                                   |
| `@lavamoat/allow-scripts`          | **Mostly moot** — pnpm `allowedBuilds` already provides the outcome (§6).                                                                                                                                                             | Repo root                                                           |
| LavaMoat scuttling                 | **Adopt where applicable.** Neutralize leftover ambient globals in webviews after bootstrap.                                                                                                                                          | Panel webviews                                                      |

The unifying principle, from the manifest plan: **reachability is the security
boundary; static analysis is the review contract.** Everything here serves the first
half — and this document is explicit about which stage delivers which slice of
reachability control, because none of the early stages deliver all of it.

## 3. The eval kernel: from shared realm to confined guest

### 3.1 Why not SES `Compartment` in workerd — and what that obliges us to build

`Compartment.evaluate` requires dynamic code generation. workerd blocks `eval` and
`new Function` except through the `UNSAFE_EVAL` binding, which SES does not know
about and which is not pluggable into SES's evaluator. Patching SES's evaluator
means forking a security-critical library — worse than not using it.

But declining the library does not grant us its properties. A Compartment provides
two things the current path lacks: a **private global environment** (guest code
resolves unshadowed identifiers against a compartment global, not the realm global)
and **controlled linkage**. Named parameters provide neither — they shadow listed
identifiers only, and `globalThis` remains the realm's. Any honest workerd
equivalent must reconstruct both. Until it does, the eval boundary is _endowment
discipline plus receiver-side enforcement_, not confinement, and the manifest plan
must not treat it as confinement.

### 3.2 Changes, in order, with the confinement level each achieves

1. **Remove the powerful globals (prerequisite, independent of SES).** The compile
   capability and per-object `require`/module map become closure-held values passed
   into the engine explicitly (`execute()` already accepts `options.require` and
   `options.compileFunction`; EvalDO already builds per-object maps — the globals
   are a bootstrap convenience, not a necessity). The lazy-import loader's global
   slot moves into the same closure-passed channel. After this step, nothing on
   `globalThis` compiles code or reaches another owner's modules.
   _Achieves:_ closes the concrete escapes (validation bypass, cross-tenant module
   reads) and resolves the boot-order contradiction — lockdown can freeze a global
   surface that no longer needs post-lockdown writes. Guest code can still _read_
   ambient realm globals.
2. **`lockdown()` at EvalDO isolate startup**, before any host DO state is
   constructed. Taming options start at `errorTaming: 'unsafe'` (real stacks in
   eval diagnostics) and `overrideTaming: 'severe'` unless compat testing forces
   `'moderate'`. Rollout follows `authority-migration-plan.md` semantics: a
   revertible commit gated by the compat suite (§3.4), **no runtime flag**.
   _Achieves:_ guest code cannot tamper with shared intrinsics — closes the
   guest→host and guest→co-tenant pollution channel. Does **not** hide any global.
3. **`harden()` the endowment surface** (with §3.3 carve-outs): the hosted-runtime
   object and its clients, the `services` proxy, module namespace objects frozen at
   publication, `ctx`, `help`, owner bindings.
   _Achieves:_ capability objects are tamper-proof. Does **not** make them
   unreachable or attenuate what they can do.
4. **Private global environment for guest code.** Reconstruct the Compartment
   property: evaluate the guest body against a guest-global scope object so
   unshadowed identifiers resolve there, not in the realm. Mechanism: SES-style
   scope proxying — an UNSAFE*EVAL-compiled sloppy-mode wrapper whose `with`-scope
   proxy mediates every free-identifier lookup, with the strict guest body inside
   (this is precisely how SES's own evaluator works; we implement the small
   wrapper, not the library). The guest global exposes the frozen shared intrinsics
   plus the endowments and nothing else; realm globals (including workerd ambient
   APIs and any host machinery) are absent, not merely frozen.
   \_Achieves:* actual confinement — guest code can reach only what is endowed.
   Only after this step may the manifest plan's "unreachable, not merely
   undeclared" claim be asserted for eval code.

   The scope object is a boundary **only** in a realm that cannot compile source:
   `({}).constructor.constructor` is `Function` for any value the guest can
   construct, so hiding the name buys nothing. `createPrivateGuestGlobal()`
   therefore refuses to build a scope in a realm where codegen is still reachable,
   and `tameRealmCodegen()` (the narrow SES codegen repair — inert `eval`,
   `Function`, and the async/generator function constructors, with the real
   compiler handed back to the bootstrap) makes a Node-side realm eligible. The
   realm that counts is the one `compileFunction` compiles into, and the same rule
   binds endowments: an endowment carried in from a codegen-capable realm reopens
   the escape through its own constructor chain.
5. **Compat/conformance suite as the gate for 2–4** (§3.4).

Steps 1–3 are cheap and independently valuable; step 4 is the load-bearing one and
carries the most implementation risk (the scope-proxy wrapper is small but
security-critical TCB and needs adversarial tests, including the classic escapes:
`Function` via constructor chains — already blocked by workerd, which is a real
assist — sloppy-mode `this`, exception objects, iterator protocol abuse).

### 3.3 What harden() must not be applied to

`harden()` freezes the public property surface. That is correct for capability
objects whose surface is an API, and wrong for objects whose surface _is_ mutable
state:

- **`scope`** (`workspace/packages/eval/src/scope.ts`) is a Proxy whose set-trap is
  the contract (`scope.foo = x` persists and notifies). It is exempt from harden.
  Its confinement story is step 4 (it is an endowment; nothing behind it is
  reachable except through its traps) plus its own trap-level guards.
- **Live module maps** mutate as imports load. The map itself stays host-internal
  (closure-held after step 1, guest-invisible after step 4); the module _namespace
  objects_ handed to guest code are hardened at publication.
- Post-run mutation of persistent scope by the host is host-side and unaffected.

Rule restated precisely: everything reachable from guest scope is either a hardened
capability object, or a deliberately mutable endowment whose mutability is its
reviewed contract and whose backing state is reachable only through its traps.

### 3.4 What this does not fix (stated, not implied away)

- **CPU/memory exhaustion.** Owners share isolates; a guest infinite loop stalls
  co-tenants today. SES never addresses this (compartments share one agent — Endo
  documents the limitation). Cooperative deadline checkpoints remain the
  mitigation; isolate-per-owner is the structural fix if pressure appears.
- **Endowment logic.** `gatewayFetch`'s `relativeOnly` rule, `db`'s reserved-table
  guards, resource attenuation per manifest-plan §7 — all remain TCB code whose
  correctness lockdown protects but does not supply.
- **Authority that flows as references.** Confinement bounds what a scope _starts
  with_. A capability object legitimately endowed to one place and then passed —
  returned from a call, handed as a callback argument — is usable by its recipient.
  See §5 for what per-package routing does and does not promise.

The compat suite covers: EvalDO host bundle, the eval engine, Sucrase output, and
runtime-support modules green under lockdown; adversarial escape tests for the
step-4 wrapper; cross-tenant non-interference tests (prototype pollution attempts
from a guest asserting co-tenant and host invariants hold).

#### Eval package-linkage regression gate

The current mono-bundle path has a concrete failure that the replacement must
carry as an acceptance test. A headless agent was given the intentionally vague
request “Choose a workspace package and tell me what it actually exposes when
loaded at runtime.” It selected `@workspace/agentic-do`. Eval's worker-target
library build flattened that package and its `@workspace/harness` dependency into
one browser-platform CJS bundle. The build then failed on transitive
`node:buffer` imports and a top-level `await` in the harness RE2 loader. No model
provider or authority decision was involved. The failed eval was terminal, but
the agent turn remained open and continued searching instead of converging on a
bounded result.

The hardened package linker and its compat suite must therefore establish all of
the following without teaching the agent a hard-coded “safe” package:

- a guest can import an arbitrary declared workspace package through the normal
  static or dynamic eval import surface, with worker export conditions selected
  consistently for every dependency edge;
- per-package output preserves async-module semantics instead of forcing a graph
  containing top-level `await` into a flat CJS artifact;
- supported Node-shaped modules such as `node:buffer` resolve only through an
  explicit, reviewed worker/eval compatibility endowment (or a target-specific
  package export), never through ambient host reachability;
- an unsupported package or export fails before guest execution with a typed
  diagnostic naming the package, export subpath, selected conditions, dependency
  edge, and unsupported runtime feature—not raw esbuild paths from a flattened
  graph; and
- either outcome settles the eval invocation and its owning agent turn. No
  library-build failure may leave a durable model effect, typing marker, or test
  session indefinitely open.

The system smoke remains deliberately behavior-oriented: an agent chooses the
package and reports the runtime namespace. Passing by steering it toward one
known-compatible package, suppressing the failed tool call, or adding a timeout
does not satisfy this gate.

## 4. Panels: lockdown is integrity, compartments are confinement

Honest framing first: panel dependencies and the panel runtime share one webview
realm and its globals. `lockdown()` + `harden()` there deliver **integrity** — the
bridge, bootstrap payload, and host modules cannot be tampered with — but not
**reachability control**: dependency code can still read `__vibestudioPanelInit`
and call anything the realm exposes. The package/guest authority boundary in
webviews arrives only with real compartments (step 3 below). Until then, the
manifest plan's confinement claims apply to panels only at the webview-process
boundary (panel vs. host), not within the webview (dependency vs. panel runtime).

1. **`lockdown()` in the webview bootstrap** (`pageHost.ts` injection, before the
   panel bundle loads), plus `harden()` of the bootstrap payload, the webview
   module map's published namespaces, and host-provided modules. Compat pass over
   react/radix and representative panels gates this (third-party browser libraries
   occasionally patch intrinsics; budget for shims).
2. **Scuttling** (LavaMoat's technique): after bootstrap captures what it needs,
   neutralize ambient globals the panel surface does not intentionally expose —
   including removing/nulling `__vibestudioPanelInit` once consumed. Reduces the
   ambient surface; does not separate code that already received references.
3. **Real SES `Compartment`s / compartment-mapper.** Webviews have native eval, so
   per-panel and per-package compartments work unmodified. This is where "per-unit
   compartment" from the manifest plan lands, and it is the step that turns panel
   integrity into panel confinement. It waits for per-package build output (§5) so
   package boundaries exist to confine.

## 5. Per-package confinement: initial authority, not total authority

LavaMoat's bundler integrations don't fit (no esbuild support; SES-compartment
runtime assumptions). The lesson we keep is its policy model; the mechanism is the
infrastructure we already have:

1. **Build dependencies as per-package, content-addressed bundles** instead of
   mono-bundles: `buildLibraryBundle` gains a mode that esbuilds each package with
   its dependencies external, keyed by content digest through the existing build
   service cache. Package boundaries survive to runtime.
2. **Link through the per-owner module map, one confinement scope per package**
   (the §3.2-step-4 mechanism in workerd; real Compartments in webviews). Each
   package scope's linkage resolves only the packages and endowments the unit's
   manifest routes to it (`packages:` attenuation, manifest plan §8).
3. **Policy is the manifest, not a parallel file.** LavaMoat generates
   `policy.json` per package and expects humans to review diffs; our equivalent is
   the manifest's request entries with `packages:` routing, generated by `pnpm
authority suggest`, never auto-applied.

**What this promises — precisely.** Routing bounds each package's **initial
authority**: what its scope is endowed with at link time. It does not, and in an
object-capability system cannot, prevent capability references from flowing
afterward — package A may pass its `network.fetch`-derived client to package B as
an argument, deliberately or accidentally, and B can then use it; A can likewise be
driven as a deputy through its exports. That is not a defect of the mechanism —
reference passing _is_ ocap delegation — but it means "package X can only ever
exercise what is routed to X" is not a true statement, and neither this plan nor
the manifest plan claims it. The honest guarantees are:

- a package with **no** route to a capability and **no** collaborator holding it
  cannot exercise it (the compression-lib-vs-`network.fetch` case, provided nothing
  hands it the client);
- cross-package authority flow happens only through explicit module-boundary
  interfaces, which are exactly the surfaces code review sees;
- receiver-side enforcement still evaluates every invocation regardless of which
  package issued it.

Deep flow control (taming what happens after references are shared) would require
membrane techniques; noted as a possible future layer, not planned.

4. **Workers/userland DOs** get the same per-package treatment when their bundles
   are produced; their host boundary (workerd bindings) is already correct.

## 6. Supply chain: mostly already in place

pnpm 10's `allowedBuilds` in the root `package.json` already restricts install
scripts to an explicit reviewed list (electron, esbuild, node-pty,
node-datachannel). Residual work is marginal and low priority: keep the list
minimal as dependencies change, and optionally adopt `@lavamoat/allow-scripts` only
if we want its auditing UX on top of pnpm's enforcement. No new protection should
be claimed from this item.

Hardening the host Node process itself with lavamoat-node is explicitly deferred:
heavyweight, the host is first-party code, and the guest-facing boundaries above
dominate the risk.

## 7. Sequencing

Ordered by value per unit risk. Rollout of every step follows
`authority-migration-plan.md`: revertible tagged commits, no runtime feature flags;
the compat/conformance suite is the merge gate, not a flag. Steps 1–3 are
independent of the authority migration's P1–P5 sequence; step 5 lands together with
manifest plan §8 and is anchored into the combined migration ordering defined in
`explicit-capability-manifest-plan.md` §14.

1. **De-globalize the eval kernel** (§3.2 step 1). Closes live escapes; no SES
   dependency; smallest diff, largest immediate win.
2. **EvalDO lockdown + harden** (§3.2 steps 2–3) behind the compat suite gate.
3. **Panel webview lockdown + harden + scuttling** (§4.1–4.2).
4. **Private guest global for eval** (§3.2 step 4) with adversarial escape tests —
   the step that makes eval confinement real.
5. **Per-package bundling + routed linkage** (§5), landing with manifest plan §8.
6. **Compartment-mapper in webviews** (§4.3), if/when panel dependency graphs
   warrant it.
7. Host-process LavaMoat: revisit after 1–6.

## 8. Completion criteria

- No object on the eval realm's `globalThis` can compile code or reach another
  owner's module map (verified by a guest snippet attempting both).
- Guest code in EvalDO cannot mutate any shared intrinsic (prototype-pollution
  attempts from a guest leave co-tenant and host invariants intact).
- Every capability object reachable from guest scope is hardened; deliberately
  mutable endowments are enumerated in the census of endowments with their
  mutability contract; a new unhardened, unenumerated endowment fails a boundary
  test, not a code review.
- After §3.2 step 4: a guest snippet resolving any identifier outside its endowed
  global fails, including the adversarial escape suite.
- Panels run under lockdown with the standard host modules; the bootstrap payload
  is consumed and removed before panel code runs; tampering with the bridge from
  panel code fails.
- A dependency package with no manifest route and no collaborator-passed reference
  to a capability cannot exercise it (once §5 lands), verified by the manifest
  plan's confinement integrity tests; the reference-passing caveat is documented in
  the manifest plan's guarantees, not silently dropped.
- The eval evaluation path is documented as the workerd guest-global mechanism, and
  no code path introduces SES `Compartment` usage inside workerd.
- The eval package-linkage regression gate in §3.4 passes for both a package with
  an async transitive dependency and a package using an explicitly endowed
  Node-compatible module; its vague agentic smoke completes with no unexpected
  tool failure or open turn.

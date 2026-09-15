# P1 Enforcement & Parity Spec

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Receiver parity requirements remain inputs to U3/U4; historical baselines must be rechecked against the current runtime.

Status: implementation spec for Phase P1 of `capability-model-redesign.md` (D7, D13,
"P1 — Shared enforcement + parity audit + safe purge"). Grounded against the worktree
as of 2026-07-21. **Audit baseline: merge-base `d54c7596`** (`git merge-base HEAD main`)
— authoritative for guard recovery everywhere in this spec and its worksheet. (The
authority work is uncommitted, so the guards are byte-identical at HEAD `dfc8d183`;
recovery is reproducible from either ref, and the migration plan's "baseline = HEAD"
observation is the same baseline — but scripts and worksheet rows cite `d54c7596`.)

Goal restated: one inbound-enforcement semantics for BOTH Durable Object bases —
attestation-verified, declaration-driven, default-deny, covering method calls AND event
deliveries — installed behind a parity audit so reachability is never wider than the
merge-base guards, then deletion of every caller-kind check.

## 0. Ground truth (verified)

- The workspace base already enforces: `inboundCallerDenial()` in
  `workspace/packages/runtime/src/worker/durable-base.ts:961-1001` checks declaration
  presence (default-deny), attestation presence, audience/method/resource binding,
  freshness, read-only vs sensitivity, then `evaluateAuthority` over
  `declaration.requires ?? requirementForPrincipals(declaration.principals)`.
- The internal base enforces nothing: `assertInboundAllowed` is a no-op
  (`packages/durable/src/index.ts:526-529`); `parseRequestBody`
  (`packages/durable/src/index.ts:163-198`) **drops the attestation** — it copies
  `callerId/callerKind/callerPanelId/userId` and discards `authorization`; the event
  path (`:537`) delivers with the no-op guard; `__lifecycle`/`__alarm` use
  `callerKind === "server"` string checks (`:423`, `:439`).
- The server already stamps `DirectAuthorityAttestation` on direct relays
  (`attestDirectRpc`, `src/server/services/authorityRuntime.ts:147-185`; 5s expiry).
  Only the workspace base consumes it.
- Merge-base effective guards (recovered via `git show d54c7596:...`):
  - `BrowserDataDO` — calls: shell | server | manifest-declared broker extension
    (`isBrowserDataDirectCaller`); events: allow (owner-scoped push).
  - `WorkspaceDO`, `EvalDO`, `WebhookStoreDO` — calls: `server` only; events: allow.
  - `ControlPlane`, `ConsoleStreamer` — no override (open at merge-base too).
- Current worktree: **all four overrides are deleted**; declarations exist on
  WorkspaceDO (56), BrowserDataDO (50), EvalDO (8), WebhookStoreDO (4); ControlPlane
  and ConsoleStreamer have **zero** `@rpc` declarations.
- BrowserDataDO's declarations are wider than its merge-base guard: e.g.
  `@rpc({ principals: ["host", "user", "code"] })` at `browserDataDO.ts:377` vs
  shell/server/broker historically. This is the canonical "reviewed widening or
  regression?" row.

## 1. Shared enforcement module

### 1.1 Location and dependency direction

New module: `packages/shared/src/directRpcEnforcement.ts` (exported via
`@vibestudio/shared`). It sits beside `authorization.ts` because it composes
`evaluateAuthority`, `requirementForPrincipals`, and `bindMethodCapability`. Both bases
take a dependency on it:

- `workspace/packages/runtime/src/worker/durable-base.ts` — `inboundCallerDenial`
  becomes a thin wrapper (audience/resource/capability computed locally, everything
  else delegated). No behavior change; its tests become the module's tests.
- `packages/durable/src/index.ts` — new consumption (this is the P1 payload).

### 1.2 API

```ts
export interface DirectRpcCheckInput {
  kind: "call" | "event";
  /**
   * Method name for calls; the canonical event pseudo-method `__event:<topic>`
   * for events (see §2) — never null, so the attestation's `method` field binds
   * exactly for both kinds.
   */
  method: string;
  eventTopic?: string;
  caller: AuthenticatedCaller | null;
  /** caller?.authorization — passed explicitly so bases can't forget to thread it. */
  attestation: DirectAuthorityAttestation | null;
  /** rpcMethodAuthority(target, method) for calls; matched intake rule for events. */
  declaration: ResolvedRpcAuthority | null;
  audience: string;      // do:<source>:<class>:<objectKey>
  resourceKey: string;   // = audience today (parity with workspace base)
  capability: string;    // `rpc:<method>` | `event:<topic>`
  now?: number;
}

export interface DirectRpcDenial {
  code: "EACCES" | "EVAL_READ_ONLY";
  reason: string;        // human-readable, method-prefixed (existing format)
}

/** Null = allowed. Pure function; no I/O, no clock other than `now`. */
export function directRpcDenial(input: DirectRpcCheckInput): DirectRpcDenial | null;
```

Check order (extracted from the workspace base, with step 3 rewritten to its final
target): (1) declaration present, else default-deny; (2) attestation present;
(3) audience/method/resourceKey bind exactly, and the attestation is **admitted at
   most once**. Final semantics, written directly so only one behavior is buildable:
   - The attestation carries a `nonce`. The receiving DO records each accepted nonce
     and rejects any attestation whose nonce has already been accepted. Nonce
     single-use is the replay defense — the *only* replay defense.
   - `issuedAt`/`expiresAt` remain in the payload, with `expiresAt` widened to a
     generous skew bound (60s). Its sole purpose is nonce-table garbage collection:
     a nonce record may be dropped once its attestation is past the bound, so an
     attestation beyond the bound is rejected *because its nonce can no longer be
     proven unused* — hygiene, never the authority mechanism. Timestamps never
     otherwise affect first acceptance; there is no tight freshness window.
   - "Stale" after prerequisite D6 means exactly: replayed nonce, or beyond the skew
     bound. Nothing else.
   The extracted module may carry the legacy 5s wall-clock check **dark** during the
   extraction/shadow steps (behavior-identical extraction), but the **step 3
   enforcement flip requires the final semantics above** — P1 is not complete while
   any wall-clock window is the live authority check;
(4) `attestation.readOnly === true` requires `sensitivity === "read"`;
(5) `evaluateAuthority({ context, requirement, resourceKey, grants, now })` where
`requirement = declaration.requires !== undefined
  ? bindMethodCapability(declaration.requires, capability)
  : requirementForPrincipals(declaration.principals, capability)`.

### 1.3 Instance-dependent `requires` (broker pattern)

BrowserData's broker-extension rule depends on an env binding
(`BROWSER_DATA_BROKER_ID`), which a static decorator literal cannot express.
`RpcAuthorityPolicy.requires` gains a factory form:

```ts
requires?: AuthorityRequirement | ((self: object) => AuthorityRequirement);
```

`rpcMethodAuthority(target, method)` resolves the factory against the live instance
(it already receives `this`). This is the only decorator change P1 makes; it exists so
the merge-base broker guard can be expressed as a declaration
(`anyOf(capability("host"), capability("user"), allOf(capability("code"),
relationship("code-source", brokerRepoPath)))`) instead of surviving as imperative code.

### 1.4 Internal-base wiring

`packages/durable/src/index.ts` changes:

1. **Thread the attestation.** `parseRequestBody` copies
   `record["authorization"]` into the caller (validated shape: the
   `DirectAuthorityAttestation` fields); the `__rpc` envelope path reads
   `envelope.delivery.caller.authorization` likewise. The `AuthenticatedCaller` type
   used by `packages/durable` must carry the same optional `authorization` field the
   workspace runtime's does (type unification, no new type).
2. **Calls:** `dispatchInboundEnvelope` replaces `assertInboundAllowed(caller,
   "call")` with `directRpcDenial({kind: "call", ...})`; a denial returns the same
   error-envelope shape the workspace base uses (`errorCode: "EACCES" |
   "EVAL_READ_ONLY"`), never a thrown 500.
3. **Events:** the `__rpc` event branch replaces `assertInboundAllowed(caller,
   "event")` with intake matching (§2) + `directRpcDenial({kind: "event", ...})`.
4. **`__lifecycle` / `__alarm`:** the `callerKind === "server"` checks are replaced
   with the host-attestation check (parity with the workspace base's
   `inboundHostControlDenial`): valid fresh attestation for this audience/method with
   `context.host !== null`. Implementation obligation on the server side: the
   DODispatch paths that invoke `__lifecycle/*` and `__alarm` must stamp attestations
   for those pseudo-methods (they are host-originated, so `attestDirectRpc` covers
   them; verify each dispatch site during implementation).
5. `assertInboundAllowed` is **deleted** (base and all overrides — none remain in the
   worktree; the deletion is of the extension point itself, so no future DO can
   reintroduce a parallel guard).

## 2. Event-intake declarations and event attestation

No declaration form exists for events today; merge-base semantics were "guarded DOs
accept all events" and event pushes carry **no attestation**. P1 closes both halves —
declarations *and* stamping — so default-deny for undeclared or unattested events is
**active at the end of P1** (parent plan D7: the complete inbound envelope surface,
calls and events both). There is no `unattested: "accept"` escape hatch and no P1.5
deferral: an unauthenticated ingress preserved "for parity" would bypass declaration
evaluation entirely, which is the regression P1 exists to close.

**Server-side event attestation stamping.** Events reach internal DOs through exactly
one path (verified): every event route collapses into `relayEvent`
(`src/server/rpcServer.ts:2855` — the deliberate single canonical path per its FIX 1
comment) whose DO branch calls `postEventToDurableObject`
(`src/server/workerdRpcRelay.ts:243`). P1 adds the mint there: the envelope's
`caller.authorization` carries `attestDirectRpc` for the target DO's audience with the
canonical **event pseudo-method `__event:<topic>`** as the attested method (capability
`event:<topic>`). One mint site covers every event source because routing is already
unified; worker-target and panel/shell-target event delivery are out of scope (they are
not the internal-DO boundary).

```ts
export interface EventIntakeRule {
  /**
   * Match on the envelope's event topic/stream key. Must be non-empty:
   * catch-all rules are banned (a lint error) — intake is declared per topic
   * family, mirroring per-method @rpc declarations.
   */
  topicPrefix: string;
  /** Same vocabulary as @rpc: either principals or requires. */
  principals?: PrincipalKind[];
  requires?: AuthorityRequirement | ((self: object) => AuthorityRequirement);
}

// Class-level:
static readonly eventIntake: readonly EventIntakeRule[];
```

Dispatch: first rule whose `topicPrefix` matches wins; no matching rule =
default-deny (mirror of undeclared methods). For a matched rule, `directRpcDenial`
runs with `kind: "event"`, `method: "__event:" + topic`, `capability =
event:<topic>`; a missing or stale attestation denies exactly as it would for a call.

Worksheet obligation: the audit enumerates each DO's actually-subscribed topics (from
dispatch sites + step-1 shadow logs) and declares topic-scoped rules for them —
expected `principals: ["host"]` for the four previously-guarded DOs, since merge-base
events were owner/server-pushed. Because merge-base accepted *all* events, every
declared rule is a **tightening** relative to merge-base, recorded as `tighten` rows
with rationale "attested, topic-scoped intake replaces accept-all" — a reviewed
narrowing, never a silent one.

## 3. The parity audit

### 3.1 Worksheet generation

New script `scripts/generate-p1-parity-worksheet.mjs` emits
`docs/runtime-foundations/p1-parity-worksheet.json` + a rendered `.md` table. Row
sources:

- **Methods:** every *runtime-public* method of every internal DO class (reflection
  parity with `exposeAll` — TS-private helpers are runtime-public and must appear),
  joined with its `@rpc` declaration if any.
- **Events:** one row per DO for the event path (plus one per distinct intake rule
  once declared).
- **Pseudo-methods:** `__lifecycle/prepare`, `__lifecycle/resume`, `__alarm`,
  `getState` per DO.
- **Merge-base guard:** recovered mechanically — `git show
  d54c7596:src/server/internalDOs/<file>` parsed for `assertInboundAllowed` overrides
  and their helper predicates (`isBrowserDataDirectCaller`). The recovery is scripted,
  not hand-transcribed; the script fails if a guard function cannot be located for a
  class that had one.

Columns per row:

| column | content |
|---|---|
| `class.method` (or `class.__event`) | identity |
| `mergeBaseGuard` | normalized: `server-only` \| `shell/server/broker` \| `open` \| `absent-method` (method didn't exist at merge-base) |
| `currentDeclaration` | `@rpc` principals/requires/sensitivity, or `undeclared` |
| `comparison` | `equivalent` \| `WIDER` \| `narrower` \| `undeclared` — computed via the §3.2 mapping |
| `disposition` | `tighten` \| `keep` \| `reviewed-widening` — **hand-filled, required** |
| `rationale` | one line, required for `reviewed-widening` and `tighten` |

The worksheet is checked in. CI fails if any row's disposition is empty, and fails if
`comparison` is `WIDER` while `disposition` is not `reviewed-widening`. Enforcement
flips on (§4 step 3) only when the worksheet is green.

### 3.2 Guard-equivalence mapping

Caller-kind vocabulary → declaration vocabulary (R3: one trust vocabulary):

| legacy guard accepts | declaration equivalent |
|---|---|
| `callerKind === "server"` | `principals: ["host"]` |
| `callerKind === "shell"` | `principals: ["user"]` (the shell acts as the user) |
| broker extension by id | `allOf(capability("code"), relationship("code-source", <broker repoPath>))` via the §1.3 factory |
| open (no override) | any declaration is `narrower` or `equivalent`; `undeclared` becomes default-deny — see §3.3 |

A declaration is `WIDER` iff it admits a (principal-kind, relationship) combination
the mapped guard refused — notably any `code` principal on a class whose guard had no
code/extension path.

### 3.3 Known rows (seed content, verified against the tree)

- **BrowserDataDO — 50 methods, `WIDER`.** Declares `host/user/code`; merge-base
  admitted shell/server/broker. Disposition recommendation: `tighten` — drop `code`,
  express the broker via the §1.3 factory requirement. Any method that should stay
  code-reachable is a `reviewed-widening` row with rationale (D7 explicitly permits
  recorded widenings; it forbids silent ones).
- **WorkspaceDO (56), EvalDO (8), WebhookStoreDO (4)** — declarations sampled
  `["host"]`; merge-base server-only → expected `equivalent`; disposition `keep`.
  The script, not the sample, is authoritative — any non-host principal that crept in
  becomes a `WIDER` row.
- **ControlPlane, ConsoleStreamer — zero declarations, open at merge-base.** Under
  default-deny every method becomes unreachable (a P2-finding-1-shaped dead end, but
  at the DO boundary). Disposition: declare every used method explicitly
  (`principals: ["host"]` expected for both; verify against their dispatch sites) or
  convert unused public helpers to true-private. `undeclared` rows with live callers
  are P1 blockers.
- **Event rows** — all four previously-guarded DOs: `tighten` — topic-scoped,
  attested, `principals: ["host"]` intake rules per §2 (merge-base accepted all
  events unattested; the narrowing is recorded with rationale, and the server-side
  stamp lands in the same phase so nothing breaks).
- **`getState`** on the internal base is runtime-public and undeclared everywhere —
  it dumps the state table. Disposition: declare `principals: ["host"]`,
  `sensitivity: "read"` at the base, or delete it if no dispatch site uses it.

## 4. Ordering

1. **Extract + wire (dark).** Land `directRpcEnforcement.ts`; workspace base delegates
   (behavior-identical, its existing tests prove it); internal base threads
   attestations and computes denials but only **logs** them (shadow mode) — no
   behavioral change yet. The server-side event stamp (§2) also lands here, dark:
   events start carrying `__event:<topic>` attestations immediately so shadow logs
   exercise the real verification path and enumerate live topics for the audit.
2. **Audit.** Generate the worksheet; fill dispositions; apply `tighten` rows
   (declaration edits + the broker factory); add event-intake rules; declare
   ControlPlane/ConsoleStreamer/`getState`. Shadow-mode logs from step 1 are the
   empirical check that green rows produce zero would-deny hits under real traffic.
3. **Enforce.** Flip the internal base from shadow to enforcing default-deny. CI gate:
   worksheet green + shadow-log clean window.
4. **Delete.** Remove `assertInboundAllowed` (the extension point), the
   `callerKind === "server"` lifecycle/alarm checks, and the D13 P1 items (§5). Only
   after step 3 has soaked — deletion is subtraction only once enforcement carries
   the restrictions (D7).

Interim guarantees, per step: after 1 — behavior identical everywhere; after 2 —
declarations are at-least-as-tight as merge-base guards (worksheet-proven) but still
unenforced on the internal base; after 3 — reachability ≤ merge-base for every
audited row (the branch's current default-open regression is closed here); after 4 —
single enforcement path, no caller-kind vocabulary anywhere.

## 5. P1 deletion list (D13 subset, exact targets)

After §4 step 3:

- `packages/durable/src/index.ts`: `assertInboundAllowed` (method + doc comment);
  `callerKind === "server"` checks in `__lifecycle`/`__alarm` branches (replaced §1.4.4).
- `packages/rpc/src/authority.ts`: `VerifiedDelegation`;
  `CodeAuthorityChain.delegations`; `AuthorityGrant.binding` and its variant types;
  the `delegation` flag on capability requirements; `device` from `PrincipalKind`
  uses tied to `deviceOwnership` (`AuthorizationContext.deviceOwnership`).
- `packages/shared/src/authorization.ts`: delegation evaluation branch
  (~L268-300); `builtinRelationship` arms `device-owned-by-user`, `entity-deputy`,
  `channel-owner/editor/member`, `delegation`.
- `packages/shared/src/serviceDispatcher.ts`: resolver-contract fields
  `acquisition`, `challenge`, `preauthorization` (+ their types
  `EvalCapabilityAcquisition`, `AuthorityChallengePresentation`);
  `ServiceDispatcher.preauthorize()` (L758); unconsumed resolver outputs.
- `packages/shared/src/typedServiceClient.ts`: the `"run"` grant scope.
- `packages/shared/src/execution/identity.ts`: `ExecutionArtifactRef` and its
  verify/parse surface; `codePrincipal`/`executionDigest` fold into the retained
  identity path used by `buildV2/builder.ts` (move, not rewrite — the builder is the
  one real consumer).
- `src/server/services/productAuthorityGrants.ts`: `binding` emission in
  `productGrant`.
- Tests asserting deleted behavior move or die with their subjects; the parity suite
  (§6) replaces the guard tests.

Explicitly NOT deleted in P1 (later phases own them): the generated catalogs and
ledger generator (P2/P3), `capabilityGrantStore` (P3 store consolidation),
`CodeAuthorityChain.execution/initiator` (reshaped in P3, not removed).

## 6. Test obligations

- **Module extraction:** workspace-base enforcement tests re-pointed at
  `directRpcDenial` (audience mismatch, read-only, default-deny,
  requires-vs-principals precedence, factory `requires`). The legacy freshness
  tests are re-pointed verbatim only for the dark/shadow steps; at the
  enforcement flip they are **replaced** by the final-semantics assertions:
  a replayed nonce denies, an attestation beyond the skew bound denies, and an
  attestation inside the bound with an unused nonce is accepted regardless of
  stamp-to-verify latency.
- **Parity regression suite (generated):** from the worksheet, one test per row
  asserting the merge-base-denied caller shapes still deny: server-only rows deny
  user/code/extension attestations; BrowserData rows deny non-broker extensions and
  (post-tighten) bare `code`; event rows deny unattested delivery, deny undeclared
  topics, and accept a host-attested `__event:<topic>` delivery for declared topics.
  Generated, so a worksheet edit without a matching declaration edit fails.
- **Attestation threading:** internal-base integration test proving
  `authorization` survives both the method-path body and the `__rpc` envelope path,
  and that a stripped attestation denies.
- **Lifecycle/alarm:** host-attested calls succeed; stale/absent attestation denies;
  the old `callerKind` spoof (body-supplied `callerKind: "server"` without
  attestation) denies — this is the regression test for the vocabulary deletion.
- **Shadow-mode fidelity:** shadow logs and enforcing denials computed by the same
  function on the same input (one code path, asserted by construction test).

## 7. Open questions

1. **`shell → user` mapping fidelity.** The shell historically carried more implicit
   trust than "the acting user" (it is also the approval surface). If any audited row
   depended on shell-not-user distinctions, the row's `requires` can express
   `allOf(capability("user"), relationship("session"))`-style narrowing; decide
   per-row in the audit rather than inventing a shell principal (R3 forbids it).
2. **`getState` fate.** Recommendation: declare host-read at the base and keep (it's
   used by diagnostics); delete only if the dispatch-site scan comes back empty.

# Capability-Grant Approval Model for System Modification

Status: design (pre-implementation). Authored alongside the DO-authorization
closures (Findings 1 + 2) and the workspace-realm default-deny migration, which
this design shapes.

## 1. Problem

The `@rpc` opt-in migration governs *which* methods are callable. It says
nothing about *who may call them* or *whether the user approved the action*.
Two separate gaps follow:

- **Reachability** — the RPC relay is intentionally open
  (`checkRelayAuth` → `{ok:true}`, `rpcServer.ts:2203`); a recipient with no
  guard accepts any authenticated runtime that can name its objectKey. Several
  internal DOs ship no guard (Finding 1); three agent-settlement endpoints
  accept untrusted completions (Finding 2).
- **Authority** — sensitive *userland-useful* system modification is gated
  inconsistently. `vcs.publish` for user-facing callers is capability-gated via
  `mainAdvanceOptions` → `mainAdvanceApproval` (the good pattern), but
  autonomous agents are handled by a **blunt callerKind block**
  (`vcsService.ts:308`). `workerd.createInstance/destroyInstance/cloneDO/destroyDO`
  and `credentials.store/revoke/grant` have **no approval gate at all** — only a
  service-level callerKind policy.

The user's rule:

> Anything useful to userland code and agents but sensitive → gated behind a
> user-approval prompt. Anything not for userland → whitelisted or closed.

## 2. Two layers — keep them separate

A sensitive call must pass **both**, and the layers must not be conflated:

| Layer | Question | Mechanism | Where | User? |
|---|---|---|---|---|
| **A — Reachability** | "May this caller's *kind/identity* reach this surface at all?" | `assertInboundAllowed` + service callerKind policy | DO inbound boundary / service dispatch | No |
| **B — Authority** | "Does the *principal* hold an approval for THIS sensitive op?" | `requestCapabilityPermission` (grant-check → prompt → record) | the sensitive *service method* | Yes |

- **Layer A is the closures**: Findings 1 + 2 (gate the infra DOs and the
  settlement endpoints) and the workspace-realm default-deny migration. Pure
  identity/kind authorization, synchronous, no user involvement.
- **Layer B is this design**: a user-approved, principal-scoped capability grant
  on the sensitive service methods.

**This is the key thing the design tells the closures:** do NOT put user-approval
logic in `assertInboundAllowed`. The closures answer reachability only. Approval
lives at the service method. The two efforts are independently testable.

## 3. Reuse — the machinery already exists

Nothing new needs inventing for the host-mediated path:

- `approvalQueue` (`approvalQueue.ts`) — shell-owned user-decision rendezvous,
  already has a `capability` kind (`CapabilityApprovalQueueRequest`, line 64),
  returns `GrantedDecision` (`once|session|version|repo|deny`), dedups, supports
  abort, and renders in the shell approval bar (+ mobile FCM).
- `CapabilityGrantStore` (`capabilityGrantStore.ts`) — persists
  `(capability, resourceKey, identity{callerId, repoPath, effectiveVersion})`
  with scope `session|version|repo`; `hasGrant()` / `grant()`; file-backed.
- `requestCapabilityPermission` (`capabilityPermission.ts`) — the proven
  check-grant → prompt → record helper, **already in production** via
  `gitInteropService.ts:273,332`, `mainAdvanceApproval.ts:198`,
  `corsApprovalService.ts`.
- `requireWorkspaceApproval` — `workspace.create/switchTo/setInitPanels/setConfig`
  already gate through `approvalQueue.requestUserland()`. **This is the target
  pattern, working today.**
- `credential_wait` effect + `feedback_form`/`feedback_custom` — proven
  defer-and-resume effects for a hibernating agent (park the loop → user acts →
  resume via `deliverEffectOutcome`). The template for the agent approval path.

## 4. Composition safety — "how deep does system modification go?"

The depth is **bounded**, for three reasons grounded in how the system already
works:

1. **Authority does not propagate to deputies.** Tokens are pure bearer identity
   (`tokenManager.ts` — `callerId ↔ token`, no embedded scopes). A worker or DO
   an agent spawns gets its **own** server-minted identity
   (`workerdManager.ts:815`, `doDispatch.ts:111`), never the spawner's. So a
   grant cannot leak to a deputy by spawning.
2. **The real bypass is "spawn a *more-privileged* deputy," and the fix kills
   it.** Today an agent blocked from `vcs.publish` (callerKind block) could
   `openPanel(...)` a panel — which *can* publish — as a confused deputy.
   Replacing blunt callerKind blocks with a **principal-scoped capability grant
   applied to every caller kind** removes the incentive: the spawned panel has a
   different identity/code-version, so its grant lookup **misses → the user is
   prompted afresh**. Spawning cannot manufacture a grant.
3. **The sensitive set is enumerable.** Capability gating is one
   `requestCapabilityPermission` call per sensitive service method (§6) — a
   finite list, not syntactic whack-a-mole. An agent routing through eval, a
   worker, or a second agent still arrives at the *same* gated service method.

Principal scoping is what makes this hold: `CapabilityGrantStore` keys grants on
`(repoPath, effectiveVersion)` — the workspace + the code version — not on a
transient callerId (except `session` scope). "Trust this code version to do X"
is approved once; different code (a spawned deputy) re-prompts.

## 5. Two call paths (mirrors the async-eval split)

- **Connection-holding callers (panel, CLI)** — synchronous `await
  requestCapabilityPermission(...)`. Exactly how `workspace.create` and
  `vcs.publish` work today; the caller holds its own connection during the
  prompt.
- **Agents (hibernating DO)** — a **deferred approval effect** (the
  `credential_wait` template). The sensitive call parks the agent loop, surfaces
  the approval (approval bar and/or an in-chat capability card), and resumes via
  `deliverEffectOutcome` on the decision. This avoids holding a model/RPC call
  open across a human-latency prompt — the *same* held-connection problem the
  async-eval plan solves, on the *same* effect-outbox substrate. Build once.

## 6. Enforcement points (the bounded list)

| Capability | Service method(s) | Current state | Action |
|---|---|---|---|
| `vcs.publish` | `vcsService.ts:301` | user-facing: capability-gated ✓; do/worker: blunt block (308) | Replace the blunt block with the capability gate so an agent can publish **with approval**; removes the spawn-a-panel bypass |
| `workerd.lifecycle` | `workerd.createInstance/destroyInstance` | policy-only, **ungated** | Add `requestCapabilityPermission`; resource = worker source |
| `workerd.do-storage` (destructive) | `workerd.cloneDO/destroyDO` | policy-only, **ungated** | Add gate; `destroyDO` is irreversible (flag `severity` on the prompt — presentation only, NOT a scope) |
| `credentials.mutate` | `credentials.storeCredential/revokeCredential/grantCredential` | policy-only, **ungated** (credential *use* at `credentialService.ts:780` is already gated) | Add gate on the mutating methods |
| `workspace.*` | `workspace.create/switchTo/setInitPanels/setConfig` | `requireWorkspaceApproval` ✓ | Keep (reference pattern) |
| `vcs.applyEdits` | `vcsService.ts:176` | confined to caller's own context head by `resolveWriteHead` | **Do NOT gate** — editing one's own head is the normal edit-first operation, not system modification |

## 7. What this means for the closures (the "informs" part)

1. Closures (Layer A) stay purely identity/kind. `assertInboundAllowed` answers
   reachability; never approval.
2. The workspace-realm default-deny migration is Layer A — kind/identity allow
   lists, no capability logic, no user.
3. Capability gating (Layer B) is added at the sensitive *service* methods,
   independently and after the closures.
4. The agent approval path and the async-eval deferral share the same
   effect-outbox substrate — leverage one mechanism, not two.

## 8. Decisions (locked with the user, 2026-06-20)

1. **Agents may `vcs.publish` *with approval*.** Convert the blunt do/worker
   block (`vcsService.ts:308`) into the same capability gate panels use. An
   autonomous agent can advance main only with an explicit, user-approved grant.
   The gate applies to every caller kind, which closes the spawn-a-panel
   confused-deputy path.

2. **The service ALWAYS requests; it NEVER persists its own scope.** Each
   sensitive method calls `requestCapabilityPermission` on EVERY invocation.
   Scope (once / session / version / repo) is the USER's choice at the prompt,
   owned and persisted by the server approval system (`approvalQueue` +
   `CapabilityGrantStore`), which returns the stored decision without
   re-prompting while the grant is valid. A calling service must NOT cache
   "already approved" or invent a grant scope — that is a bug (cf.
   `requestUserlandApproval`: "Do not cache the result. The host owns
   persistence, deduplication, scope, and revocation."). Per-capability
   `severity` only adjusts how the prompt is presented, never a persistence
   policy.

3. **Approval surfaces in the shell approval bar** (+ mobile notifications),
   reusing the existing credential/capability prompt path. An in-chat card can
   be layered on later.

## 9. Sequencing

1. **This design** (done) →
2. **Closures (Layer A)** — Findings 1 + 2, then the workspace-realm
   default-deny migration →
3. **Capability gating (Layer B)** — wire `requestCapabilityPermission` at the
   §6 methods; add the deferred agent-approval effect on the async-eval
   substrate.

## 10. Implementation status (2026-06-20)

**Layer A — DONE + green.** Findings 1/2/3 closed; the workspace realm migrated
to declarative `@rpc({ callers })` default-deny (all ~150 DO methods). Docs in
`workspace-dev/WORKERS.md`.

**Layer B — DONE + green**, with two refinements the implementation surfaced:
- The deferred agent-approval effect was **not needed** — the existing
  `withCapability` (`capabilityPermission.ts`) already does the inline-vs-defer
  split via `deferIfNeeded` (granted/connection-holding caller → inline; ungated
  agent → defers the approve-then-act out-of-band). Layer B just wraps each
  sensitive method in it.
- `workerd.createInstance/destroyInstance/updateInstance` → capability-gated for
  panel/app/**do**; **workers bypass** (a spawned/infra worker runs under the
  authority that created it — gating it broke worker-spawns-worker + fork).
- `workerd.cloneDO/destroyDO` are **not approval-gated** — they're fork/storage
  *primitives*, not userland features (the fork worker uses them; approval there
  breaks fork and gives confusing "clone DO storage?" UX). Per the closure rule
  ("not-for-userland → close"), they are **closed** to userland callers instead
  (`requireInfraCaller`: worker/server/extension only).
- `vcs.publish` — the blunt do/worker block removed; agents publish their OWN
  context head **with approval** via the existing `mainAdvanceOptions` →
  `mainAdvanceApproval` capability gate (already handles do/worker).
- `credentials` — **no new gate**: `grantCredential` is already deprecated,
  credential *use* is already capability-gated, and `storeCredential` is
  host-OAuth-flow-internal; the existing credential approval machinery suffices.

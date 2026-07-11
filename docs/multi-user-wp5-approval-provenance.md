# WP5 — Governance & Approval Provenance Log (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§6 — the emphasized deliverable) and
`docs/multi-user-wp0-user-identity-spec.md` (`UserSubject` on `VerifiedCaller`). Records
**who approved/denied what, who invited/revoked/added whom, and when**, durably and queryably —
and surfaces resolutions live so the shared approval queue reads as a collaborative surface.

**Framing (plan §0.0 — trusted members).** This is an **attribution/provenance** log for a
mutually-trusting team, not a tamper-proof security audit against insiders. It is an
exact-schema, transactional SQLite ledger rather than a hash-chained tamper-evident ledger.
The hub is the sole database writer: workspace children submit approval records over the
authenticated internal control route, while the hub writes membership records directly. We
keep the log because "who approved this / who added that member" is genuinely useful history;
we do **not** spend complexity defending it against the very members it attributes.

Obeys the host-boundary invariants (`plan §0.1`): the host governance log is **host-owned**
(INV-2 — the host records its own decisions; it does not write into userland GAD); identity
comes from the verified `subject`, never the wire (INV-3).

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** capture the resolving user on every approval-queue resolution; eliminate
identity collapse and inline external-agent attribution gaps; a **single
settlement coordinator** in the queue so the resolution snapshot (incl. `resolvedBy`) actually
reaches live listeners (fixes the delete-before-emit bug, §6); a host-owned, transactional
**governance log** (SQLite, no hash chain) that records both **approval
resolutions** and **membership governance** (invite/revoke/add/remove-member, role change);
extend the userland GAD agent-approval projection to carry the resolving account; a read-only
unified view.

**Out of scope:** the `subject` binding itself (WP0); making the queue "shared" (it already
is — §2); role gates on _who may_ resolve (queue policy already allows shells; roles gate
host-admin ops in WP9, not routine approvals). **Explicitly out of scope: tamper-evidence /
hash chains / cryptographic audit** — trusted members (plan §0.0).

**Exit criteria:**

1. Every resolution of every approval kind writes one durable governance record naming the
   resolving `userId` (+ handle, device), the requester, the decision, and the resource.
2. Every membership-governance op (invite, revoke, add/remove member, role change) writes one
   governance record naming the acting user and the target — so "who let this person in" is
   answerable.
3. Desktop and mobile resolutions are both attributable from their verified caller contexts.
4. The live resolution event carries `resolvedBy` **and reaches listeners** — the settlement
   coordinator emits the snapshot before the entry is removed (§6).
5. A unified "governance" view lists host-queue approvals + membership events + agent-tool
   approvals together, read-only.
6. Grant matching is unchanged — still keyed on code identity; provenance is additive.

---

## 2. Starting point (investigation)

- The queue is **already shared**: one global `approvalQueue` (`index.ts:628`), resolution
  fans out to all coalesced waiters, `policy.allowed = ["shell","app","server"]`
  (`shellApprovalService.ts:31`) already lets any device resolve any entry, and grants bind
  to **code identity** — so an approval by user A satisfies a matching request from anyone.
  "Any user approves, all consume" is structurally met; only **attribution** is missing.
- **Today's entire approval "audit"** is an in-memory counter:
  `metrics.recordApprovalResolved({decision, source: ctx.caller.runtime.kind})`
  (`shellApprovalService.ts:42,63,…`, `pushMetrics.ts`) — no identity, no timestamp, no
  persistence.
- **Two approval systems** (GAD investigation):
  - **(a) Agent tool-call approvals** — already journaled in userland GAD:
    `approval.requested`/`approval.resolved` events keyed by `causality.approvalId`, projected
    into the resolve-once `trajectory_approvals` table with `requested_by_json`/
    `resolved_by_json` (`workspace/workers/gad-store/index.ts:1833-1846`, `projectApproval`
    `:4008-4056`).
  - **(b) Host approval-queue resolutions** — credential, capability, client-config,
    credential-input, userland, unit-batch, device-code, external-agent — resolve in-process
    with no durable, queryable record. **This is the gap WP5 fills.**

---

## 3. Ownership split (INV-2)

| System                                                    | Home                                | Why                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| (a) Agent tool-call approvals                             | **userland GAD** (existing)         | they live on the agent trajectory, written by userland `PiRunner`; extend only the resolver identity                           |
| (b) Host approval-queue resolutions                       | **host-owned governance log** (new) | the host owns the approval queue and its record; writing host decisions into a userland-forkable store is a boundary inversion |
| (c) Membership governance (invite/revoke/add/remove/role) | **same host-owned governance log**  | the hub/host performs these ops; they are host facts about who admitted whom                                                   |
| Unified view                                              | read-only **union**                 | one timeline for humans; neither store writes into the other                                                                   |

The host governance log is `governance/governance.db`, implemented by
`packages/shared/src/governance/governanceLog.ts`. It uses one exact SQLite schema, WAL,
`synchronous=FULL`, transactional batch append, and a unique `approval_id` for idempotent
lost-response retries and deterministic conflict rejection. **No hash chain**: the host is the
sole trusted writer and the audience is mutually-trusting members (plan §0.0), so
tamper-evidence machinery would be complexity defending against a threat we've declared out
of scope. No JSONL governance reader or migration exists.

---

## 4. Resolver-identity capture

**Capture point:** every resolve/submit handler in `shellApprovalService.ts`
(`resolve`, `resolveBootstrap`, `resolveUserland`, `resolveExternalAgent`,
`resolveExternalAgentByRequest`, `submitClientConfig`, `submitCredentialInput`,
`submitSecretInput`), where `ctx.connectionId`, `ctx.wsClient`, and — post-WP0 —
`ctx.caller.subject.userId` are in scope.

Two load-bearing rules keep resolutions attributable:

1. **No client-supplied acting-principal field.** Desktop and mobile approval calls run under
   the authenticated connection's `VerifiedCaller`; `resolverFrom(ctx)` reads only
   `ctx.caller.subject`. The main-process client does not send a parallel `userId`/`deviceId`
   argument or retain an `ActingPrincipal` compatibility seam.
2. **Inline external-agent path.** `approvalQueue.resolveExternalAgentByRequest` routes through
   the same service capture and settlement coordinator as the approval-id path, so inline
   conversation-card verdicts are attributed too.

The `approvalQueue` itself (`approvalQueue.ts`) is the wrong layer — it has no `ctx`.
Provenance is recorded by the **service** immediately around the `approvalQueue.resolve*`
call.

---

## 5. Governance record & event

One record per resolution, appended to the host governance log; the same shape is mirrored
into GAD for the (a) agent path.

```ts
// packages/shared/src/governance/types.ts
export interface ApprovalProvenanceRecord {
  approvalId: string;
  approvalKind:
    | "credential"
    | "capability"
    | "client-config"
    | "credential-input"
    | "secret-input"
    | "userland"
    | "unit-batch"
    | "device-code"
    | "external-agent";
  decision: "once" | "session" | "version" | "deny" | "dismiss" | "submit";
  granted: boolean; // deny/dismiss → false
  workspaceId: string;
  resolvedAt: number;
  // WHO approved — the verified human (INV-3):
  resolvedBy: { userId: string; handle: string; deviceId?: string; deviceLabel?: string };
  resolvedVia: "shell" | "mobile-notification" | "app" | "server";
  // WHO/what asked — already on PendingApproval (approvalQueue.ts:554-569) + ApprovalRequesterIdentity:
  requestedBy: {
    callerId: string;
    callerKind: string;
    repoPath?: string;
    effectiveVersion?: string;
    userId?: string;
  };
  // WHAT was approved:
  resource?: {
    capability?: string;
    key?: string;
    value?: string;
    credentialId?: string;
    subjectId?: string;
  };
  grantScopeStored?: "session" | "version" | null; // scope the server persisted (null for once/deny)
}
```

- **Field sourcing (identity resolution):** `resolvedBy.userId`/`handle` come from the
  resolver's own verified `subject` (they hold the connection). `resolvedBy.deviceLabel` and
  any _other-user_ field (e.g. rendering the requester's handle when it differs) are read via
  the **WP0 §3.7 shared identity DB** (`identityDb.deviceLabels` / `identityDb.resolveUsers`,
  opened read-only) — the child holds no writable identity store.
- **`requestedBy.userId` must be captured at request-enqueue time.** `PendingApproval`
  (`approvalQueue.ts:554-569`) does not carry a user today; the enqueue path (the service that
  calls `approvalQueue.request`) stamps the **requesting** caller's `subject.userId` onto the
  pending approval when it is created, so the resolution record can name both parties. (This
  is a small addition to the request side, not just the resolve side.)
- **Host log:** transactionally append `ApprovalProvenanceRecord` (and
  `MembershipGovernanceRecord`, §5.1) to `governance/governance.db`. A unique
  approval id makes lost-response retries idempotent and rejects conflicting
  verdicts. No `prevHash`/line-hash chaining.
- **GAD (agent path):** the existing `approval.resolved` event
  (`payloadKind: "approval.resolved.v1"`) gains the account on
  `payload.resolvedBy` and on `actor.metadata.userId`; extend `projectApproval`
  (`gad-store/index.ts:4008`) so `resolved_by_json` carries the account. **Do not** set
  `actor.kind = "user"` — that kind is the semantic "human-authored" role, not an account
  (GAD substrate review); the account rides in `metadata`.

### 5.1 Membership-governance record

The hub/host mutates membership (WP1 `inviteUser`, WP2 `addMember`/`removeMember`, WP9
`revokeUser`/role change). Each such op appends one record to the **same** governance log:

```ts
// packages/shared/src/governance/types.ts
export interface MembershipGovernanceRecord {
  kind: "membership";
  op: "invite-user" | "revoke-user" | "add-member" | "remove-member" | "role-change";
  actor: { userId: string; handle: string; deviceId?: string }; // who performed it (verified subject)
  target: { userId: string; handle?: string }; // who it was done to
  workspaceId?: string; // for add/remove-member
  role?: "root" | "admin" | "member"; // for invite/role-change
  at: number;
}
```

Written by the hub-side service that performs the op (it holds the acting `subject`), so "who
let this person in / who revoked them" is permanently answerable — the primary reason a trusted
team still wants a log. This is host-owned like the approval records; same file, same reader.

---

## 6. Settlement coordinator & live surface (fixes delete-before-emit)

**The bug this section fixes.** Today `approvalQueue.resolve()` calls `settleDecisionEntry`,
which `removeEntry` **first** and only then `emitPendingChanged` (`approvalQueue.ts:1223`). So
by the time listeners fire, the resolved entry is already gone — there is no clean place to
hang `resolvedBy` for the live surface, and a naive "look up the entry in the changed handler"
finds nothing. Adding `resolvedBy` to the broadcast is not enough; the **ordering** is wrong.

**Fix: a single settlement coordinator.** Route every resolution through one
`settle(entry, resolution)` path in `approvalQueue` that:

1. **Snapshots** the resolution — `{ approvalId, decision, granted, resolvedBy, requestedBy,
resource, grantScopeStored }` — from the still-present entry plus the resolver's verified
   `subject`, _before_ any removal.
2. **Awaits** the hub governance writer's durable acknowledgement. If persistence fails, the
   entry remains pending and no success is exposed.
3. **Emits** a `shell-approval:resolved` signal carrying that snapshot (the live `resolvedBy`
   surface — it no longer depends on the entry still existing).
4. **Then** removes the entry, settles coalesced waiters, and emits `pending-changed` with the
   post-removal queue. One snapshot feeds both the durable and live surfaces, so they cannot
   disagree.

All resolve/submit handlers and the inline `resolveExternalAgentByRequest` path (§4) go
through this one coordinator — no handler removes an entry directly. This collapses the two
prior problems (attribution + ordering) into a single well-defined choke point.

- Because within a workspace the queue is broadcast to all members (WP4 keeps intra-workspace
  broadcast), every connected user sees **who acted** — the shared queue becomes visibly
  collaborative.
- The approval bar / mobile sheet render "Approved by @gabriel just now" on already-resolved
  entries, driven by the `resolved` snapshot rather than a lookup of the vanished entry.

---

## 7. Unified view

A read-only "Governance" surface unions:

- the host governance log — approval resolutions **and** membership events (queried host-side
  via a new `governance.list({filter})` read RPC), and
- the GAD agent-approval projection (via the existing `gad-browser` panel /
  `trajectory_approvals` read path).

Neither store writes the other. The panel presents one time-ordered, filterable timeline
("all approvals by @alice", "all credential denies this week", "who approved `github-repos`",
"who invited @dave"). `gad-browser` (`workspace/panels/gad-browser`) gains a Governance tab for
the agent half; a small host-fed panel/section renders the host-log half.

---

## 8. Non-negotiables

- **Grant matching stays code-identity-scoped** (`capabilityGrantStore`,
  `credentialUseGrantStore`, `userlandApprovalGrantStore`) — provenance records _who
  approved_ but never fragments a shared grant per user, or "all consume from one queue"
  breaks (`plan §2.1`, `docs/capability-approval-design.md:80-98`).
- **Do not reuse `CredentialUseGrant.grantedBy`** — it stores the scope _string_, not a human
  (`credentialService.ts:5011-5038`).
- The host governance log is **host-owned**; userland can _read_ a projection of it (mutual
  inspectability within a workspace) but cannot write or mutate it.

---

## 9. Testing

- **Attribution per surface:** resolve a `capability` approval from desktop and the same kind
  from mobile; assert one governance record each with the correct `resolvedBy.userId`
  (including the previously-lost Electron path).
- **All kinds:** each of the nine approval kinds produces a record on its applicable terminal
  outcomes.
- **Membership records:** an `inviteUser`/`revokeUser`/`addMember`/`removeMember`/role-change
  each writes one `MembershipGovernanceRecord` naming actor and target.
- **Grant unchanged cross-user:** user A approves `version` scope; a later matching request
  from user B's device running the same code hits the grant with **no** re-prompt — and the
  provenance log still shows A as the approver.
- **Settlement ordering (the delete-before-emit fix):** resolving an entry fires a `resolved`
  event carrying `resolvedBy` _while the snapshot is intact_, and a listener reads `resolvedBy`
  successfully — proving the emit no longer races the entry removal (§6).
- **GAD extension:** an agent tool-call approval resolved by a human yields a
  `trajectory_approvals` row whose `resolved_by_json` carries the account; `actor.kind` is
  **not** `"user"`.
- **Live surface:** a second connected user sees `resolvedBy` on the resolution event.
- **Boundary:** the host governance store never imports `workspace/`
  (`pnpm check:host-boundary`).

---

## 10. File-change checklist

| File                                              | Change                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/governance/types.ts`         | **new** — `ApprovalProvenanceRecord`, `MembershipGovernanceRecord`                                                                                                                     |
| `packages/shared/src/governance/governanceLog.ts` | **new** — host-owned exact-schema transactional SQLite ledger, WAL + full synchronous durability, approval-id replay protection (**no** hash chain)                                    |
| `src/server/services/approvalQueue.ts`            | **single `settle(entry, resolution)` coordinator** — snapshot → emit `resolved` → remove → govern (fixes delete-before-emit `:1223`); route `resolveExternalAgentByRequest` through it |
| `src/server/services/shellApprovalService.ts`     | capture resolver subject in every handler; all resolutions go through the queue's `settle` coordinator                                                                                 |
| `src/main/serverClient.ts`                        | no acting-principal payload or identity-override seam; the authenticated connection supplies the verified subject                                                                      |
| hub/WP2 membership services                       | emit `MembershipGovernanceRecord` on invite/revoke/add/remove/role-change                                                                                                              |
| `workspace/workers/gad-store/index.ts`            | `projectApproval` reads account into `resolved_by_json`; `approval.resolved.v1` carries `actor.metadata.userId`                                                                        |
| `src/server/services/governanceService.ts`        | **new** — `governance.list` read RPC (host-side; approvals + membership)                                                                                                               |
| `workspace/panels/gad-browser/*`                  | Governance view (union of host log + GAD projection)                                                                                                                                   |
| `pushMetrics.ts`                                  | keep counters; they are metrics, not the record (no longer the only one)                                                                                                               |

---

## 11. Decisions (resolved — nothing deferred)

1. **Governance log store: exact-schema SQLite**, with transactional batch appends,
   approval-id uniqueness, WAL, and full synchronous durability. No hash chain
   (trusted members, §intro).
2. **Retention:** retained in the hub state directory, documented in `STATE_DIRECTORY.md`.
3. **Secret-input denials are attributed:** these resolve in-app (not from a notification), and
   `ctx` is present there, so the record captures the resolver identity like every other kind.

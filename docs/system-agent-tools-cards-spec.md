# System Agent — Eval, Overview, and Card Contracts

Status: draft for review
Depends on: `system-agent-design.md` (§3–§4, §7.2),
`system-agent-sa0-plan.md` (§1–§8), `capability-model-redesign.md` (§5, R1–R4 reconciliation),
`multi-user-wp3-panel-forest.md`, `multi-user-wp7-channels-multihuman.md`,
`multi-user-wp8-presence.md`, `stage0-unified-log-spec.md`

This document fixes the wire contracts for the System Agent's full EvalDO surface, complete
per-turn overview, structured cards, and shell/eval parity. It does not define an agent-specific
tool API. The conversation model sees only `eval` and `say`; shell operations are ordinary typed
runtime/service calls made from eval.

## 1. Full eval contract

### 1.1 Existing EvalDO, unchanged

The System Agent uses `createEvalTool` and `eval.run` exactly as normal agents do. It receives the
complete `evalImportableSurface` and `EVAL_AMBIENT_ONLY` bindings defined by
`packages/service-schemas/src/runtime/runtimeSurface.eval.ts`, including the platform's normal:

- `services` and `rpc` typed service access;
- the complete context-sandboxed `fs`, VCS/runtime APIs, workspace imports, and network helpers;
- `panelTree`, `runtime`, `parent`/`getParent`, and context APIs;
- `chat` bound to the System Agent channel;
- persistent per-conversation `scope` and synchronous `db`;
- `help()`/service schema discovery;
- console capture, async execution, output windowing, and recovery pointers.

No binding, import family, service namespace, or code syntax is removed for the System Agent. No
privileged binding exists only for it. Service authorization still withholds protected
non-delegated approval payload/settlement, delegated-authority expansion, and independent
trust-root administration; the ordinary EvalDO surface itself is unchanged. Missing shell
reachability is repaired in the shared service/runtime layer.

The filesystem binding is a capability capsule, not raw disk. `fs`, `node:fs`,
`node:fs/promises`, file-backed eval, `services.fs`, `callMain("fs.*")`, and raw RPC filesystem
calls all resolve through `FsService` as the EvalDO entity. Its context is derived from the
host-registered owner lineage. Eval cannot choose another context, receive `host-fs-access`, see
native paths, or reuse file handles outside that context.

### 1.2 Owner and audit lineage

Every service call from the per-channel EvalDO carries trusted lineage:

```ts
export const systemAgentEvalLineageSchema = z.object({
  evalDoId: z.string(),
  ownerCodePrincipal: z.string(),       // code:workspace/workers/system-agent@<blessedEv>
  actingUserId: z.string(),
  originatingDeviceId: z.string(),
  workspaceId: z.string(),
  contextId: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
}).strict();
```

These fields are derived from the verified owner/subKey and turn ingress. Eval source cannot set
or replace them. R3 authorization evaluates the blessed owner EV; the audit record retains both
the EvalDO and owner chain. Cross-owner, cross-channel, edited-EV, and caller-kind-only claims fail
before target resolution.

### 1.3 Tool registry invariant

The conversation registry is exactly:

```ts
type SystemAgentToolName = "eval" | "say";
```

There are no generated observation/action tools, docs/search tools, filesystem tools, web tools,
or debug/palette/log special tools. Their underlying capabilities remain available inside eval.
The policy-evaluation micro-session used by SA1 is a different invocation mode and is not the
System Agent conversation.

## 2. Shell/eval semantic parity

### 2.1 Coverage entry

`packages/shell-core/src/evalParity.ts` is a verification manifest, not a dispatch catalog:

```ts
type ShellEvalParityEntry =
  | {
      kind: "service";
      uiOperation: string;
      service: string;
      method: string;
      promptRecipe: string;
    }
  | { kind: "renderer-plumbing"; uiOperation: string; rationale: string }
  | { kind: "human-secret-input"; uiOperation: string; formRouteMethod: string }
  | { kind: "human-approval-consent"; uiOperation: string }
  | { kind: "independent-administration"; uiOperation: string; rationale: string };
```

For `service` entries, CI proves that desktop/mobile use the shared method, the method exists in
the typed service registry, the System Agent EvalDO's blessed owner chain is authorized to reach
it, and the bundled eval handbook contains a schema-valid recipe. The manifest does not create a
tool, wrapper, alternate result type, or confirmation path.

`renderer-plumbing` is limited to non-semantic mechanics such as overlay geometry/paint, mouse
forwarding, and raw event transport. `human-secret-input` may expose a method that opens/routes the
form to the originating device, but entered values are absent from eval, overview, transcript,
and service results. Stored credential material is likewise non-extractable; eval can request only
authorized opaque use. `human-approval-consent` keeps delegation activation/renewal/widening in
verified shell chrome. Protected approval payload read/settlement is available only to that chrome
or an exact matched-policy micro-session. `independent-administration` covers the System Agent's
own blessed EV, grants, prompt/tool policy, locked roster, approval and credential rules, and audit
integrity.

### 2.2 No parallel path

Chrome, mobile, and eval call the owning service/runtime implementation. UI-only semantic logic is
factored into that shared implementation. A direct service call from eval is therefore the
intended path, not a bypass.

Direct service access never means direct backing-store access. Host databases, identity and
approval registries, credential material, audit storage, and native filesystem paths remain
encapsulated by their owners.

CI fails on:

- an unclassified user-visible shell operation;
- a UI semantic handler that does not terminate in its mapped shared method;
- a mapped method absent from the eval service/runtime surface;
- a prompt recipe with a stale method or invalid arguments;
- an agent-only reimplementation or System Agent-only service;
- a shell/eval grant mismatch.

## 3. Complete `ShellOverview` contract

`packages/shell-core/src/shellOverview.ts` owns the schemas shared by host, workspace, device,
worker, eval, and UI.

### 3.1 Top-level shape

```ts
export const shellOverviewSchema = z.object({
  generatedAt: z.number(),
  revisions: z.object({
    panels: z.number(), entities: z.number(), presence: z.number(),
    channels: z.number(), units: z.number(), approvals: z.number(),
    notifications: z.number(), services: z.number(),
  }).strict(),
  actor: z.object({
    userId: z.string(), deviceId: z.string(), workspaceId: z.string(),
  }).strict(),
  focus: z.object({
    panelId: z.string().optional(), cardRef: shellRefSchema.optional(),
  }).strict(),
  panelForest: panelOverviewForestSchema,
  entities: z.array(runtimeEntityOverviewSchema),
  workspaceMembers: z.array(workspaceMemberOverviewSchema),
  workspacePresence: z.array(workspacePresenceOverviewSchema),
  channels: z.array(channelOverviewSchema),
  units: z.array(unitOverviewSchema),
  approvals: z.array(approvalOverviewSchema),
  notifications: z.array(notificationOverviewSchema),
  incidents: z.array(incidentOverviewSchema),
  devices: z.array(deviceStatusOverviewSchema),
  updates: z.array(updateOverviewSchema),
  paletteCommands: z.array(paletteCommandOverviewSchema),
  unavailable: z.array(z.object({
    projection: z.enum(["host", "workspace", "device"]),
    code: z.string(), message: z.string(),
  }).strict()),
}).strict();
```

`unavailable.length === 0` defines a complete overview. A failed projection is visible; stale
state is not silently substituted.

### 3.2 Shared refs

```ts
export const shellRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("panel"), id: z.string() }),
  z.object({ kind: z.literal("entity"), id: z.string() }),
  z.object({ kind: z.literal("worker"), id: z.string() }),
  z.object({ kind: z.literal("channel"), id: z.string() }),
  z.object({ kind: z.literal("session"), id: z.string() }),
  z.object({ kind: z.literal("unit"), id: z.string() }),
  z.object({ kind: z.literal("workspace"), id: z.string() }),
  z.object({ kind: z.literal("device"), id: z.string() }),
  z.object({ kind: z.literal("approval"), id: z.string() }),
  z.object({ kind: z.literal("notification"), id: z.string() }),
]);

export const logRefSchema = z.object({
  sourceKind: z.enum(["panel", "worker", "server"]),
  sourceId: z.string(), logId: z.string(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
}).strict();

export const shellResultRefSchema = z.union([
  shellRefSchema,
  z.object({ kind: z.literal("log"), ref: logRefSchema }).strict(),
]);
```

### 3.3 Structural rows

```ts
const panelOverviewNodeSchema = z.object({
  panelId: z.string(), parentId: z.string().nullable(), ownerUserId: z.string(),
  title: z.string().max(256),                 // UNTRUSTED
  source: z.string().max(512),                // UNTRUSTED
  contextId: z.string().nullable(),
  state: z.enum(["active", "unloaded", "archived"]),
  focused: z.boolean(), pinned: z.boolean(), collapsed: z.boolean(),
  runtimeLeaseHolder: z.string().nullable(),
  lastActiveAt: z.number().nullable(), recentErrorCount: z.number().int(),
}).strict();

const panelOverviewForestSchema = z.object({
  revision: z.number(),
  owners: z.array(z.object({
    userId: z.string(), handle: z.string().max(128), displayName: z.string().max(256),
    color: z.string().optional(), rootPanelIds: z.array(z.string()),
  }).strict()),
  nodes: z.array(panelOverviewNodeSchema),
}).strict();

const runtimeEntityOverviewSchema = z.object({
  entityId: z.string(),
  kind: z.enum(["panel", "app", "worker", "do", "session"]),
  source: z.string().max(512),                 // UNTRUSTED
  title: z.string().max(256).optional(),       // UNTRUSTED
  contextId: z.string(), parentEntityId: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  effectiveVersion: z.string(), upgradePolicy: z.enum(["follow-head", "pinned"]),
  state: z.enum(["running", "stopped", "crashed", "starting", "retiring"]),
  createdAt: z.number(), startedAt: z.number().nullable(),
  restarts: z.number().int(), recentErrorCount: z.number().int(),
}).strict();

const channelOverviewSchema = z.object({
  channelId: z.string(), contextId: z.string().nullable(),
  title: z.string().max(256).nullable(),        // UNTRUSTED
  ownerUserId: z.string().nullable(),
  createdAt: z.number().nullable(), lastActivityAt: z.number().nullable(),
  members: z.array(z.object({
    userId: z.string(), handle: z.string().max(128), displayName: z.string().max(256),
    addedBy: z.string().nullable(), addedAt: z.number().nullable(),
  }).strict()),
  participants: z.array(z.object({
    participantId: z.string(), kind: z.enum(["user", "agent", "panel", "worker", "app"]),
    userId: z.string().nullable(), handle: z.string().max(128),
    status: z.enum(["online", "idle", "away", "offline"]),
    lastSeen: z.number().nullable(), entityId: z.string().nullable(),
  }).strict()),
  agentEntityIds: z.array(z.string()),
}).strict();

const unitOverviewSchema = z.object({
  name: z.string().max(512),                    // UNTRUSTED
  kind: z.enum(["panel", "app", "worker", "extension", "job"]),
  effectiveVersion: z.string().nullable(),
  buildState: z.enum(["healthy", "building", "failed", "unknown"]),
  runningEntityIds: z.array(z.string()),
  recentErrorCount: z.number().int(),
}).strict();
```

The overview contains every WP3 node, active entity, visible channel, durable member, live
participant, unit, and current operational row. Display fields are bounded but rows are not
dropped. It excludes log bodies, message history, secrets, panel payloads, and arbitrary extension
data. Approval rows contain only mechanical pending metadata (id/kind/severity/status/issuer ref),
never the protected request payload or decision options. It is injected ephemerally and is also
returned by the ordinary overview service in eval.

## 4. Eval patterns for shell work

The bundled handbook teaches composable programs rather than one-tool-per-operation:

### 4.1 Inspection and aggregation

Eval may page any authorized service and reduce data in code before returning it. Unified-log
service limits and RPC/eval output bounds remain normal platform constraints; there is no
System Agent-specific 20-row query cap. Large raw data should stay in `scope`, `db`, or blobstore
while the eval return contains refs/counts/summaries.

### 4.2 Mutations

Eval calls owning service methods directly under the verified owner/actor lineage. Existing
service authorization and approval behavior applies. There is no action receipt, proposal card,
typed-intent compiler, or generated wrapper. Multi-step programs may inspect, decide, and perform
several related shell operations in one eval. Protected non-delegated approval payload/settlement
is deliberately denied; eval sees only mechanical pending metadata and non-expanding delegation
management. It may draft/list/explain/revoke policies but cannot activate, renew, or widen them.

### 4.3 Context filesystem

Eval has the complete ordinary context filesystem, including Node-shaped compatibility and scratch
paths. Every access is rooted in the immutable context registered for the EvalDO owner. Absolute
and relative paths, symlinks, `realpath`, open handles, file-backed eval, imported libraries,
`services`, `callMain`, and raw RPC cannot escape or select another context. Tracked mutations keep
their normal GAD routing. The System Agent is categorically ineligible for extension-only
`host-fs-access`.

### 4.4 Device and secret flows

Device-local semantic methods route to `originatingDeviceId` and fail visibly if it is unavailable.
Secret/credential/client-config form routes may be opened from eval, but values travel only from
the human form to the owning secret store and never return through eval. Existing stored credential
material is also opaque: authorized clients may use it without exposing its bytes.

### 4.5 Debug dispatch

Eval uses the ordinary agent/channel launch APIs to create a normal userland debug session, posts
a briefing containing canonical refs and selected context, and publishes a debug-link card. The
child receives its normal workspace surface; no System Agent privilege is inherited.

## 5. Structured card payloads

Cards are optional product-bundled message payloads, not tools or authorization objects. Eval can
import their schemas/factories and publish them through `chat`; chrome can post them after direct
UI actions.

```ts
export const shellOverviewCardSchema = z.object({
  kind: z.literal("shell-overview"),
  generatedAt: z.number(), complete: z.boolean(),
  counts: z.object({
    panelOwners: z.number().int(), panels: z.number().int(),
    entities: z.number().int(), onlineUsers: z.number().int(),
    channels: z.number().int(), liveParticipants: z.number().int(),
    units: z.number().int(), pendingApprovals: z.number().int(),
    unreadNotifications: z.number().int(), activeIncidents: z.number().int(),
  }).strict(),
  unavailable: z.array(z.string()),
  refs: z.array(shellRefSchema),
}).strict();

export const panelSubtreeCardSchema = z.object({
  kind: z.literal("panel-subtree"),
  rootPanelId: z.string().nullable(),
  nodes: z.array(panelOverviewNodeSchema),
  refs: z.array(shellRefSchema),
}).strict();

export const entityStatusCardSchema = z.object({
  kind: z.literal("entity-status"),
  entities: z.array(runtimeEntityOverviewSchema),
  refs: z.array(shellRefSchema),
}).strict();

export const workspacePresenceCardSchema = z.object({
  kind: z.literal("workspace-presence"),
  members: z.array(workspaceMemberOverviewSchema),
  presence: z.array(workspacePresenceOverviewSchema),
  refs: z.array(shellRefSchema),
}).strict();

export const channelSessionCardSchema = z.object({
  kind: z.literal("channel-session"),
  channels: z.array(channelOverviewSchema),
  refs: z.array(shellRefSchema),
}).strict();

export const unitStatusCardSchema = z.object({
  kind: z.literal("unit-status"),
  units: z.array(unitOverviewSchema),
  refs: z.array(shellRefSchema),
}).strict();

export const logExcerptCardSchema = z.object({
  kind: z.literal("log-excerpt"),
  sourceKind: z.enum(["panel", "worker", "server"]),
  sourceId: z.string().nullable(),
  window: z.object({ since: z.number(), until: z.number() }).strict(),
  matchedCount: z.number().int(), truncated: z.boolean(),
  countsByLevel: z.record(z.enum(["verbose", "info", "warn", "error"]), z.number().int()),
  excerpts: z.array(z.object({
    ref: logRefSchema, level: z.enum(["verbose", "info", "warn", "error"]),
    at: z.number(), text: z.string().max(500), textTruncated: z.boolean(),
  }).strict()).max(20),
  refs: z.array(z.object({ kind: z.literal("log"), ref: logRefSchema }).strict()),
}).strict();

export const logShareCardSchema = z.object({
  kind: z.literal("log-share"), ref: logRefSchema,
  lines: z.array(z.string()), byteLength: z.number().int(), truncated: z.boolean(),
  sharedByUserId: z.string(),
  refs: z.array(z.object({ kind: z.literal("log"), ref: logRefSchema }).strict()),
}).strict();

export const incidentCardSchema = z.object({
  kind: z.literal("incident"),
  sourceKind: z.enum(["panel", "worker", "server"]),
  sourceId: z.string(), sigHash: z.string(),
  template: z.string().max(500),                  // UNTRUSTED
  severity: z.enum(["info", "warn", "critical"]),
  summary: z.string().max(200).nullable(),        // UNTRUSTED
  counts: z.object({
    total: z.number().int(), last5m: z.number().int(), last60m: z.number().int(),
  }).strict(),
  firstSeen: z.number(), lastSeen: z.number(),
  exemplars: z.array(z.object({
    text: z.string().max(500), ref: logRefSchema,
  }).strict()).max(3),
  refs: z.array(shellResultRefSchema),
}).strict();

export const stormCardSchema = z.object({
  kind: z.literal("storm"),
  sourceKind: z.enum(["panel", "worker", "server"]),
  sourceId: z.string(), severity: z.enum(["info", "warn", "critical"]),
  summary: z.string().max(200).nullable(),        // UNTRUSTED
  since: z.number(), endedAt: z.number().nullable(),
  peakRate: z.number().nonnegative(), currentRate: z.number().nonnegative(),
  sampleK: z.number().int().min(1), sampled: z.boolean(), totalCount: z.number().int(),
  sigMix: z.array(z.object({
    sigHash: z.string(), template: z.string().max(500), count: z.number().int(),
  }).strict()).max(3),
  refs: z.array(shellResultRefSchema),
}).strict();

export const debugSessionLinkCardSchema = z.object({
  kind: z.literal("debug-session-link"),
  channelId: z.string(), sessionId: z.string(), target: shellRefSchema,
  title: z.string().max(120),
  refs: z.array(shellRefSchema),
}).strict();

export const ackCardSchema = z.object({
  kind: z.literal("ack"),
  operation: z.enum(["resolve-conversation", "revoke-device"]),
  refs: z.array(shellRefSchema),
}).strict();
```

The SA1-owned `delegationDraftCardSchema` is imported from
`packages/service-schemas/src/delegation.ts`:

```ts
export const systemAgentCardSchema = z.discriminatedUnion("kind", [
  shellOverviewCardSchema,
  panelSubtreeCardSchema,
  entityStatusCardSchema,
  workspacePresenceCardSchema,
  channelSessionCardSchema,
  unitStatusCardSchema,
  logExcerptCardSchema,
  logShareCardSchema,
  incidentCardSchema,
  stormCardSchema,
  debugSessionLinkCardSchema,
  delegationDraftCardSchema,
  ackCardSchema,
]);
```

## 6. Untrusted-field rule

Normative untrusted fields include panel/entity/channel/unit titles and sources; profile/member/
participant names and status copy; palette metadata; logs; watcher/model summaries; incident
templates; debug titles; and delegation description/guidance.

Clients render these fields as inert text: no markdown, HTML, auto-linking, attribute
interpolation, executable deep links, or dynamic renderer lookup. Eval prompt demarcation labels
them as data. This is hygiene and UI safety, not an action-authorization boundary.

## 7. User-shared logs

“Share with agent” remains an attributed content gesture. The host caps each posted share at
16 KiB, marks truncation, and posts `LogShareCard`. It is useful for directing attention but is
not required for access: full eval can query authorized unified logs directly. Sharing adds no
authority and no special confirmation state.

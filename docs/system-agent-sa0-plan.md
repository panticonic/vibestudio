# System Agent SA0 — Full Eval in Shell Context and Runner

Status: draft for review
Parent design: `system-agent-design.md` (§3, §8 SA0)
Depends on: `capability-model-redesign.md` (§5, R1–R4 reconciliation),
`multi-user-wp0-user-identity-spec.md`, `multi-user-wp3-panel-forest.md`,
`multi-user-wp7-channels-multihuman.md`, `multi-user-wp8-presence.md`,
`stage0-unified-log-spec.md`, `agentic-architecture.md`, `ws2-channel-spec.md`

SA0 makes the System Agent a product-owned, pinned `AgentWorkerBase` with exactly the operational
surface the platform already gives serious agents: **full server-side eval** in its own persistent
`EvalDO`. The eval is rooted in the shell-owned context and has the complete portable runtime,
service discovery, workspace imports, context-sandboxed filesystem/VCS, network helpers, channel APIs, persistent
`scope`/`db`, and shell service access. The model-visible tool surface is only `eval` plus `say`.

There is no generated forest of panel/worker/session tools, no agent-only mini-shell, no action
receipt, and no second intent classifier. Product-owned prompts teach the agent to inspect and
operate the shell through eval. Existing service authorization, approval, identity, and audit
mechanisms remain the enforcement boundary.

## 0. Findings that determine the design

1. **The full-power execution primitive already exists.** `createEvalTool` runs TypeScript/JS in a
   per-owner, per-channel `EvalDO`. It already supplies `services`, `rpc`, `fs`, `panelTree`,
   `runtime`, `chat`, `scope`, `db`, imports, and the rest of `@workspace/runtime`. A System
   Agent-specific execution engine would be a fork of the platform.

2. **The shell breadth already lives in services and runtime APIs.** Panel topology/lifecycle,
   runtime entities, units, workspaces, profiles/presence, channels, pending-approval metadata, notifications,
   device operations, logs, palette commands, and agent launch paths have owning implementations.
   The missing work is making any UI-only semantic behavior callable through those shared APIs,
   not wrapping each behavior in a model tool.

3. **A large tool registry is less capable than eval.** It duplicates schemas, fragments
   composition across tool calls, makes new shell functions easy to omit, and prevents ordinary
   code from filtering/aggregating state before returning a bounded result. Eval plus good recipes
   is both smaller and more expressive.

4. **Eval identity must follow its verified owner.** An EvalDO has its own runtime identity, but
   privileged calls must retain the immutable owner chain
   `EvalDO → SystemAgentWorker code@blessedEv → acting user/device`. R3 grants bind to the blessed
   code EV; an arbitrary EvalDO or edited worker must not inherit them by caller-kind or name.

5. **Complete awareness is separate from execution.** The agent should not have to write discovery
   code before answering a basic status question. A fresh complete `ShellOverview` is injected on
   every human turn; eval is for detail, aggregation, and action.

6. **Full eval changes the injection claim.** Once the model can execute arbitrary code against
   its authorized service surface, untrusted text in its context can influence that code. There is
   no honest mechanism-level claim that prompt injection cannot cause a shell action. The design
   bounds when the agent runs, isolates the watcher, pins the code/prompt, and retains ordinary
   service approvals and audit; it does not pretend eval is safe because it is reached through a
   differently named wrapper.

7. **The runtime filesystem is already a capsule.** Eval's `fs`, Node filesystem compatibility,
   file-backed eval, rich service client, and raw RPC routes all resolve through the EvalDO
   entity's host-registered context. Full context filesystem access is required; native host and
   cross-context filesystem authority are not.

## 1. One operational surface: existing EvalDO

### 1.1 Tool registry

`SystemAgentWorker.getLoopTools(channelId)` returns exactly:

1. `say`, using the normal agent response path;
2. `eval`, created by the existing `createEvalTool(..., { subKey: channelId })`.

No `shell_overview`, `panels_*`, `entities_*`, `logs_query`, `palette_*`,
`spawn_debug_session`, docs, filesystem, web, commit, or subagent **model tools** are registered.
Those capabilities are available inside eval through the ordinary runtime and service clients.
`memory_recall` remains disabled because it is currently registered outside `getLoopTools()` and
would otherwise violate the two-tool contract.

The System Agent uses the same eval service, EvalDO class, sandbox, import loader, output
windowing, persistent scope, and SQLite binding as normal agents. There is no privileged eval
fork and no reduced “safe eval” dialect.

### 1.2 Shell-context ownership

The System Agent entity is launched inside the workspace-integrated shell context. Its per-channel
EvalDO inherits that entity context through the normal eval owner/subKey binding. Therefore:

- the complete context-sandboxed filesystem and VCS operate on the shell workspace context;
- `panelTree` sees the visible WP3 forest permitted to the acting user;
- `services`/`rpc` reach the same typed service registry ordinary eval uses;
- `chat` is bound to the locked System Agent channel;
- `scope` and `db` persist for that System Agent conversation only;
- workspace imports and `gatewayFetch` behave exactly as in normal eval.

Every filesystem spelling—`fs`, `node:fs`, `node:fs/promises`, file-backed eval,
`services.fs`, `callMain("fs.*")`, and raw `rpc` calls—must converge on that same context capsule.
The EvalDO entity's `contextId` is derived from verified owner lineage and is never an eval
argument. The System Agent cannot receive the extension-only `host-fs-access` capability, expose
native host paths, reuse handles across contexts, or select another context by path or RPC args.

If the current eval lineage cannot represent a non-panel shell owner cleanly, fix the general
owner/context lineage. Do not add a System Agent path or pretend a nearby visible panel owns it.

### 1.3 Product-owned eval prompt

The bundled prompt has an eval-first shell handbook generated/validated against the actual runtime
and service schemas. It includes concise recipes for:

- reading the injected overview and refreshing it from the overview service;
- panel forest inspection and lifecycle operations;
- listing/inspecting all runtime entity kinds and contexts;
- workspace users, WP8 presence, channel members, and live participants;
- workspace/target/unit lifecycle and diagnostics;
- pending-approval metadata, delegation draft/list/explain/revoke, notifications, incidents,
  devices, updates, and settings; protected approval payload/settlement and human-only delegation
  activation/renewal/widening are documented separately in §4.2;
- log queries, in-eval filtering/aggregation, and log refs;
- panel command discovery/execution;
- launching a normal debug agent/channel and publishing its link;
- posting bundled structured cards through the normal channel message API;
- using `help()`/service schemas when a method is unfamiliar.

The recipes use real method names and strict schemas extracted from the build. CI fails if a recipe
references a missing method or stale argument. Workspace prompt files and skills do not replace or
prepend this product prompt, though eval remains free to inspect/import workspace code as requested.

## 2. Shell semantic parity through shared services

The source of truth is the shell's typed service/runtime surface, not an agent capability catalog.
Every user-visible shell effect must terminate in one shared owning implementation. Desktop and
mobile call it directly; eval reaches ordinary semantic methods while the classified human-input,
consent, administration, and renderer boundaries stay in the same service plane.

### 2.1 Coverage rule

For every semantic desktop/mobile shell command, CI records exactly one of:

- the typed service/runtime method that implements it and is reachable from System Agent eval;
- `renderer-plumbing`, limited to geometry, paint, mouse forwarding, raw subscriptions, and
  equivalent non-semantic mechanics;
- `human-secret-input`, where eval may open/route the native form but entered values never return
  to the model;
- `human-approval-consent`, where protected request payload and settlement remain available only
  to shell chrome or an exact matched-policy micro-session, and delegation activation/renewal/
  widening remains a verified human chrome action;
- `independent-administration`, for changes to the System Agent's own blessed EV, grants,
  prompt/tool policy, locked roster, approval/credential rules, or audit integrity.

There is no `agentToolName`, result-tool schema, confirmation policy, or generated model-tool
descriptor. An unclassified UI semantic handler, an eval-inaccessible owning method, or an
agent-only reimplementation fails parity CI.

### 2.2 UI-only behavior becomes a service, not an agent adapter

When chrome currently implements a semantic operation locally, factor its behavior into the
appropriate shared service/runtime method and have chrome call it. Device-local operations expose
typed service calls that route to the verified originating device. Examples include focus,
devtools, native external-open, and opening a secret-entry form.

This is ordinary product architecture: the agent calls the same method as chrome. Renderer paint
and raw transport stay local because they have no semantic result for an agent to request.

### 2.3 Full shell families

Parity covers at least:

- panels/views: complete forest, focus, create, navigate, move, pin/collapse, load/unload,
  reload/rebuild, archive, history, lease/takeover, address discovery, browser navigation,
  theme/chrome state, devtools;
- runtime: every `panel | app | worker | do | session` entity, contexts, launch, restart,
  stop/retire, diagnostics;
- workspaces/targets: list/select/create/fork/delete, versions, launch sessions, relaunch;
- units: list, versions, builds, diagnostics/log refs, restart, rollback;
- collaboration: profiles, membership, WP8 presence, channels/sessions, durable members, live
  participants/presence, invites, notifications;
- governance/operations: pending-approval metadata, delegation draft/list/revoke, incidents/signatures,
  ordinary settings/updates, apps/cache, paired devices, credentials status/forms, autofill,
  external-open; activation/renewal/widening and trust-root administration stay human/admin-only;
- panel-contributed commands through their existing registry/service APIs;
- debug-agent launch through the existing `launchAgentIntoChannel` path.

## 3. Complete `ShellOverview`

`packages/shell-core/src/shellOverview.ts` owns the compact structural snapshot:

```ts
interface ShellOverview {
  generatedAt: number;
  revisions: {
    panels: number; entities: number; presence: number; channels: number;
    units: number; approvals: number; notifications: number; services: number;
  };
  actor: { userId: string; deviceId: string; workspaceId: string };
  focus: { panelId?: string; cardRef?: CardRef };
  panelForest: PanelOverviewForest;
  entities: RuntimeEntityOverview[];
  workspaceMembers: WorkspaceMemberOverview[];
  workspacePresence: WorkspacePresenceEntry[];
  channels: ChannelOverview[];
  units: UnitOverview[];
  approvals: ApprovalOverview[];
  notifications: NotificationOverview[];
  incidents: IncidentOverview[];
  devices: DeviceStatusOverview[];
  updates: UpdateOverview[];
  paletteCommands: PaletteCommandOverview[];
  unavailable: ProjectionFailure[];
}
```

Rules:

- **Complete:** no depth, row, owner, or activity-window filter. Every WP3 panel node, active
  entity, visible channel, durable member, live participant, unit, and current operational row is
  present.
- **Compact:** structural metadata and bounded display strings only. No log bodies, channel
  history, secrets, panel payload bodies, or arbitrary extension state.
- **Boundary-clean:** host, workspace, and originating-device projections are assembled by their
  owners and merged in the worker. Host code does not import channel semantics.
- **Fresh:** inject immediately before every human model turn and refresh after eval changes state
  before another model step.
- **Honest:** a failed projection is named in `unavailable`; stale data is never presented as a
  complete snapshot.

Inside eval the same assembler is callable through its ordinary typed service, so code can refresh
or obtain the machine structure without a special model tool.

## 4. Identity, grants, approvals, and audit

### 4.1 Immutable eval owner chain

Calls originating in the System Agent EvalDO carry a host-verified chain:

```ts
{
  caller: "do:vibestudio/internal:EvalDO:<derived-key>",
  owner: "code:workspace/workers/system-agent@<blessedEv>",
  actingUserId: "<user>",
  originatingDeviceId: "<device>",
  contextId: "<shell-context>",
  conversationId: "<channel>",
}
```

The EvalDO key is derived by the existing owner/subKey formula and accepted only when it matches
the calling System Agent entity. Owner/actor/device are not eval arguments. The host stamps them
at turn ingress and the eval service propagates them.

### 4.2 Authority model

- R3 grants bind to the seed-blessed System Agent EV and are exercised through the verified eval
  owner chain. Editing/copying the worker changes its EV and grants nothing.
- The grant set covers the service methods required for complete shell parity, excluding protected
  approval payload read/settlement, delegation activation/renewal/widening, and independent
  trust-root administration. It is audited in CI against §2's shell/eval coverage map.
- Owning-service authorization, WP0 visibility, channel membership, device binding, severity
  gates, and the existing approval queue still run normally.
- Calls are audited with EvalDO id, blessed owner EV, acting user, originating device,
  conversation/turn, service method, arguments subject to normal redaction, and outcome.
- Secret-entry values remain in the human form path and never enter eval, transcript, or audit
  payloads.
- Stored credentials remain opaque: eval may request an authorized use but cannot extract their
  material. Direct service calls never expose host databases, identity/approval/audit stores, or
  other backing state.
- The System Agent cannot bless its replacement, alter its grants or product prompt/tool policy,
  unlock its roster, weaken approval/audit rules, or otherwise authorize itself.
- Normal platform execution controls—cancellation/deadlines, concurrent-run and spawn quotas,
  service rate limits, and fan-out limits—apply to the System Agent without reducing its semantic
  shell surface.

There is deliberately no `shellActionReceipt`, typed-turn compiler, model proposal token, or
agent-specific dispatcher. A human message starts the turn; within that turn the System Agent may
use its full authorized eval surface. Operations that the platform already subjects to approval
still create ordinary approval requests.

Calls from the conversation EvalDO to non-delegated approval payload or settle methods are denied.
Conversation eval may see mechanical pending metadata only. Shell chrome may inspect/settle as the
human; an isolated policy micro-session may inspect/settle exactly one matched request using its
single-use evaluation token. The conversation EvalDO never receives that token or authority.

Conversation eval may draft, list, explain, and revoke delegation policies. Only verified human
chrome may activate, renew, or widen one. This is the same consent boundary, not a receipt or
special model tool.

### 4.3 Accepted injection consequence

Full eval means attacker-influenced overview fields, logs, panel content, or service results can
affect code the model chooses to execute. The design does not claim otherwise. Mitigations are:

- no autonomous conversation turns;
- no watcher-to-agent machine path;
- full provenance and ordinary service approvals;
- pinned product code/prompt and locked channel roster;
- inert structured-card rendering and prompt guidance;
- dispatch of deep work to ordinary sessions where appropriate.

These reduce exposure and blast radius; they are not a proof that injected text cannot cause an
authorized action.

## 5. Locked channel and conversation lifecycle

Channel structural fields remain:

```ts
{
  owner: "user:{userId}",
  rosterPolicy: {
    allowlist: ["user:{userId}", "code:workspace/workers/system-agent@{blessedEv}"]
  },
  origin: "system",
}
```

`resolveConversation()` accepts no identity arguments. The host derives user/device, creates or
recovers the pinned worker and locked channel, and returns `{channelId, entityId}`. One
conversation exists per `(workspaceId,userId)` and is shared across that user's devices with
device attribution. Cross-user joins and userland publishers fail through R4.

The EvalDO is per conversation because `subKey = channelId`; its persistent scope/db do not cross
users or System Agent conversations. Device revocation ends that device's sessions but not the
user-owned conversation.

## 6. `SystemAgentWorker` overrides

| Override | Behavior |
| --- | --- |
| `getParticipantInfo()` | handle `system-agent`; no model/approval-level config mutation |
| `loadPromptResources()` | bundled shell eval guide only; no workspace prompt/skill index |
| `getAgentPrompt()` | product-owned eval-first supervisor prompt |
| `getPromptOverride()` | hard `undefined` |
| `getLoopTools()` | exactly `say` + the existing full `eval` tool |
| standard tools | `memory_recall` disabled through a general base-class seam |
| `getDefaultModel()` | host-level per-user setting, workspace default only as fallback |

Before `runner.runTurn`, inject a fresh `ShellOverview` under a fixed product-authored
demarcation. Conversation compaction remains summary + roughly 12 recent turns; current shell
state lives in the ephemeral overview, not the summary.

## 7. Former special tools as eval recipes

| Former tool | Eval-first replacement |
| --- | --- |
| `shell_overview` | call the typed overview service; filter/aggregate in code |
| panel/entity/unit/session list/inspect tools | call owning typed services/runtime APIs |
| `logs_query` | query/page the unified log service, process in eval, return only useful output |
| `palette_list` / `palette_run` | inspect and invoke the panel command registry/service |
| `spawn_debug_session` | call `launchAgentIntoChannel`, publish briefing, post/open link |
| filesystem/VCS/docs/web tools | use eval's existing `fs`, runtime imports, `help()`, and network helpers |
| subagent tool | launch ordinary agents/channels through runtime services |

Log and eval result transport retains the platform's normal RPC/context output bounds. There is
no System Agent-specific 20-line query ceiling: eval can page and aggregate large datasets without
dumping them into model context.

## 8. Cards and desktop UI

Cards remain product-bundled structured message renderers, not model tools. Eval can publish them
through the ordinary `chat`/channel message API using importable product schemas/factories. The
prompt includes recipes for overview, entity, presence, channel, unit, logs, incident, storm,
delegation, and debug-link cards.

Card buttons are normal verified UI actions that call the same owning service methods as shell
chrome. They do not require a model turn or an agent-specific dispatcher. Resulting state/events
appear through existing subscriptions; a card may post an attributed structured result message
when conversation history benefits from it.

The desktop ambient strip and drawer remain. The drawer resolves the locked conversation, renders
bundled cards, and supplies verified focus/device state for the next overview. It has no model-tool
bridge beyond the normal channel loop.

## 9. Work items

1. **General eval owner-chain support.** Ensure EvalDO service calls preserve verified owner EV,
   acting-user, device, conversation, and turn lineage; add spoof/cross-owner tests.
2. **Shell semantic service audit.** Enumerate desktop/mobile UI semantic handlers, factor local
   behavior into shared typed methods, and create the shell/eval parity coverage gate.
3. **Eval grant audit.** Grant the blessed owner chain every shell method in parity scope except
   protected approval payload/settlement, delegation activation/renewal/widening, and independent
   trust-root administration; reject
   missing and extra unreviewed grants; preserve ordinary owning-service checks.
4. **Overview projections.** Host/workspace/device projections, merge/revisions, completeness and
   projection-failure tests, ephemeral runner injection.
5. **Pinned worker.** Blessed EV launch, locked R4 channel, prompt isolation, host model setting,
   disable unconditional memory recall.
6. **Two-tool loop and context filesystem.** Reuse `createEvalTool` unchanged, register only
   eval/say, and verify full ambient bindings/imports/persistent scope/db. Prove that every
   filesystem spelling reaches the owner-derived context capsule and that host/cross-context paths
   and `host-fs-access` are unreachable.
7. **Eval handbook.** Generate/validate service recipes from actual schemas; cover every shell
   family, large-data aggregation, cards, and debug dispatch.
8. **Cards/UI.** Bundled renderers, ordinary service-backed card actions, ambient strip/drawer,
   transcript/device attribution.
9. **Adversarial and parity gates.** Wrong-EV/owner denial, channel isolation, overview
   completeness, full eval reachability, context-filesystem escape denial, credential non-return,
   delegation/trust-root denials, resource-bound enforcement, watcher separation, and explicit
   prompt-injection behavior tests.

## 10. Exit verification

SA0 is complete only when:

1. The model tool registry is exactly `eval` and `say`.
2. Eval is the ordinary full EvalDO surface—services/rpc, runtime imports, complete
   context-sandboxed fs/VCS, network, panelTree, chat, scope/db—with the shell-owned context and no
   System Agent dialect. `fs`, Node fs, file-backed eval, services, and raw RPC cannot reach host or
   cross-context paths.
3. “What is happening?” is answerable from a complete first-turn overview containing all panel
   owners/nodes, every runtime entity kind, workspace presence, channel members/live participants,
   sessions, units, pending-approval metadata, notifications, incidents, and focus/leases.
4. Every desktop/mobile semantic shell capability is callable from eval through its shared owning
   service, except renderer plumbing, human-entered secret values, protected human approval
   consent/authority expansion, and independent trust-root administration; a gap fails CI.
5. Representative multi-step programs compose reads and actions across panels, runtime,
   collaboration, units, non-expanding delegation management, logs, palette commands, devices, and
   debug launch in one eval; protected approval payload/settlement and delegated-authority
   expansion remain unreachable.
6. Normal userland/edited workers and unrelated EvalDOs cannot exercise blessed shell grants;
   the genuine per-channel EvalDO can, with complete actor/device/owner audit lineage.
7. Secret values and stored credential material never enter eval. Non-delegated approval payload/
   settlement and delegation activation/renewal/widening remain unreachable. Existing
   owning-service approvals and authorization still run, and the agent cannot modify its trust root.
8. The watcher cannot call eval or publish to the System Agent; only a human forward creates a
   conversation turn.
9. Adversarial tests explicitly record the accepted fact that prompt injection can influence an
   authorized eval action; no documentation claims an action-intent firewall that does not exist.
10. Cancellation/deadlines, concurrent-run and spawn quotas, service rate limits, and fan-out
    limits prevent runaway eval from exhausting the hub while leaving the semantic shell surface
    intact.

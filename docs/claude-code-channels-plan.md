# Claude Code Sessions as First-Class Channel Agents

Status: IMPLEMENTED (2026-07-06, rev 3 — big-bang, all workstreams W1–W7 landed together;
typecheck host/userland/mobile, all unit suites, and the boundary checker green).
Rev 2 replaced the earlier `agent-external` participant-class redesign with a userland
**linked-agent vessel**: the Claude Code session's system identity is a real agent DO,
and the local process is a thin peripheral attached to it.
Rev 3 makes the plan **big-bang**: everything below is one scope and one landing — no
milestone sequencing, no deferred follow-ons, no optional tiers of ambition. The former
"later" items (Claude Code as a subagent target, adoption mode + plugin, remote context
mirrors) are in scope and land in the same cut.
Companion docs: `docs/ws2-channel-spec.md` (channel substrate), `docs/fork-and-subagents-plan.md`
(contexts/subagents), `docs/agentic-architecture.md`, `docs/cli.md`,
`docs/multi-user-wp1-hub-control-plane.md`.

## 0. Goal

A Claude Code session running in a vibestudio terminal is a **peer agent** of the
workspace, not a foreign process:

1. It runs **inside a context folder** (a real VCS-branched working tree), placed there
   by the terminal.
2. It is an **agent on our Pub/Sub channels** — joined by the _same invitation flow as
   every other agent_, with identity, presence, addressing, and a durable trajectory —
   surfaced to Claude Code via its native **channels** mechanism (an MCP server we
   implement).
3. It has the **full `vibestudio` CLI** available and auto-scoped to its context — and
   through `vibestudio eval`, **programmatic execution inside the system** (userland,
   context-scoped), which is the real "full functionality of the running server".
4. Its tool-use **permission prompts flow into our approvals system**, so the user
   approves Claude Code actions from the workspace UI or mobile like any other approval.
5. Everything above works from **one command / one click** — no manual pairing, config
   authoring, or session-file bookkeeping.

Design stance (per project policy): where the current system doesn't fit, we change the
system. No compatibility shims, no legacy paths. Breaking changes are enumerated in §9.

## 1. How Claude Code channels work (external constraint)

From the Claude Code docs (research preview, v2.1.80+):

- A **channel is an MCP server** that Claude Code spawns as a local subprocess over
  stdio. It declares `capabilities.experimental['claude/channel'] = {}`.
- The server **pushes events** into the running session via
  `notification({ method: 'notifications/claude/channel', params: { content, meta } })`.
  Claude receives them as `<channel source="..." ...meta>content</channel>` tags; events
  queue and are delivered on the next turn.
- Two-way channels expose a normal MCP **tool** (e.g. `reply`) that Claude calls to send
  outbound messages.
- **Permission relay** (v2.1.81+, `capabilities.experimental['claude/channel/permission']`):
  Claude Code sends `notifications/claude/channel/permission_request`
  (`{request_id, tool_name, description, input_preview}`) to the channel server and
  accepts a verdict via `notifications/claude/channel/permission`
  (`{request_id, behavior: "allow"|"deny"}`).
- Activation: `claude --channels server:<name>` where `<name>` is an entry in the
  session's MCP config. Custom (non-marketplace) channels currently additionally require
  `--dangerously-load-development-channels`.
- The session can be simultaneously interactive (terminal UI) and channel-connected.
- Hooks (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd) run
  independently and are our source of structured lifecycle events.

Everything else in this plan is our side of the contract.

## 2. Current state, and where the agent's identity should live

Two facts anchor the design:

- **The CLI is a thin device client.** `src/cli` is host code under the boundary checker
  (`scripts/check-host-workspace-imports.mjs` scans `src/`): it speaks RPC with
  `packages/shared` schemas and must not import workspace (userland) packages. That is
  the _right_ shape for it — same tier as the desktop shell and mobile: paired device
  clients whose power comes from what the server exposes, not from linked-in userland
  code.
- **Userland placement already has a front door: eval.** `vibestudio eval` executes
  TS/JS server-side in an `EvalDO` inside workerd, scoped to a session entity's context.
  Code running there _is inside the system_: it can import workspace packages, use
  `connectViaRpc`, call services, and touch the context working tree. This — not CLI
  feature accretion — is the full-functionality surface for an agent.

Consequence for the channel integration: the Claude Code session's **system identity
must live in userland as a real agent vessel DO** (a _linked-agent vessel_, §5). The
vessel joins channels exactly the way every agent joins — invited, subscribed via the
shared launch primitives, `agent-do` semantics, heartbeats, fork-cloning — and the local
Claude Code process is a **peripheral attached to its vessel** through a thin bridge.
This removes any need to redesign the channel participant model, keeps the
host/userland boundary untouched, and means a dead terminal process degrades to "agent
offline", not "participant vanished".

Remaining friction points, and the verdict on each (extend, don't work around):

| Friction                                              | Verdict                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Terminals aren't context-scoped                       | Extend shell extension + panel with first-class context placement (§4) |
| No vessel kind for externally-driven agents           | New linked-agent vessel worker on the existing vessel base (§5)        |
| CLI has no server push on loopback (HTTP only)        | Give the CLI a persistent WS transport; the bridge needs it (§6.1)     |
| CLI context scoping ignores cwd                       | cwd/env context discovery with explicit precedence (§6.2)              |
| No identity for autonomous external processes         | New `agent` caller kind + entity-scoped credentials (§3)               |
| No messaging surface in the CLI                       | New `channel` command group over shared schemas (§6.3)                 |
| Claude Code permission prompts invisible to workspace | Permission relay → approvals service, via the vessel (§7.3)            |
| No structured trajectory for external agents          | Hooks → vessel → `agentic.trajectory.v1` (§7.4)                        |

## 3. Identity & auth: the `agent` principal

### 3.1 New caller kind: `agent`

Add `agent` to `PRINCIPAL_KIND_REGISTRY` (`packages/shared/src/principalKinds.ts`,
`codeIdentity: false`) and to `CallerKind` in `@vibestudio/rpc`. Semantics: _an
autonomous external process acting as a workspace agent_ — distinct from `shell` (a
paired human-driven device) so service policies and approval flows can treat autonomous
tool use differently from a human at a prompt.

Every `ServicePolicy.allowed` list is reviewed once and updated deliberately (no blanket
grant). Initial grants: `channel`, `fs`, `vcs`, `eval`, `docs`, `events`, `runtime`
(scoped methods), `serverLog` (read). Denied by default: auth admin, hostLifecycle,
workspace management. The compile-time parity guard forces the sweep.

Invariant: **the `agent` grant set must remain a subset of what `do` can reach.**
Agent-authored code already executes as `do` inside the EvalDO (§6.4), so `do` is the
agent's real capability ceiling; keeping `agent` ⊆ `do` guarantees the direct-CLI path
is never an escalation over the eval path (nor vice versa). A policy test asserts this
subset relation against the registered service definitions.

### 3.2 Entity-scoped agent credentials

New auth surface (extend `authService` + `DeviceAuthStore`):

- `auth.mintAgentCredential({ entityId, contextId, channelId, ttl?, scopes? })` —
  callable by `extension` (the launch-orchestrator extension, §4.2) and `server`;
  deliberately _not_ by `shell`/`panel`/`agent`, so credentials are only ever minted
  through an orchestrator's prepare flow (with its `ctx.approvals` gate), never ad hoc
  by a device or by a running agent. Returns `{ agentId, agentToken }`.
  The credential authenticates as caller kind `agent`, principal `agent:<entityId>`,
  and the RPC layer stamps the binding (entityId, contextId, vessel ref) onto the
  connection so services and the vessel can enforce scope without trusting
  client-supplied ids.
- Lifecycle follows the entity: `retireEntity` revokes outstanding agent credentials.
  Tokens are refresh-style (same redeemer pipeline as `refresh:<deviceId>:<token>`,
  new prefix `agent:<agentId>:<token>`), redeemed at WS auth exactly like device
  credentials — one auth model everywhere, per the attachable-server design.

This removes any temptation to hand the raw device credential of the human's CLI pairing
to an autonomous process. The same credential powers both the bridge (§7) and every
`vibestudio` CLI invocation inside the session.

## 4. Context-scoped terminal sessions & the launch orchestrator

### 4.1 Shell extension: contexts become a first-class parameter

- `shell.open()` / `shell.exec()` gain `contextId?: string`. When set, the extension asks
  the host to materialize the folder (new extension-host capability
  `workspace.ensureContextFolder(contextId)`, backed by the existing
  `WorkspaceVcs.ensureContextFolder`) and confines cwd resolution to
  `resolveWithin(contextFolder, parsed.cwd)` instead of the workspace root.
- Session records and `list()` output carry `contextId`; in context sessions the
  git-branch probe is replaced by the context's VCS status (branch display = context
  head via `vcs.contextStatus`, not `.git` reads).
- The terminal panel gains a context picker on new-tab/split: "workspace root" (default)
  or any live context, plus "new context…" (creates a `session` entity first). Split
  inherits the parent's context.

### 4.2 The launch orchestrator is an extension: `@workspace-extensions/claude-code`

All Claude-Code-specific knowledge lives in **userland, as an extension**
(`workspace/extensions/claude-code/`) — the same tier and pattern as the shell
extension: node access, `ctx.approvals`, services reachable as caller kind `extension`,
public methods callable over RPC by panels and the CLI. The host gains exactly **one**
new primitive (`auth.mintAgentCredential`, §3.2); everything else the orchestrator
needs already exists as generic host surface (entity creation, `ensureContextFolder`,
runtime queries) or userland surface (vessel launch primitives, channel invitation).
Host code never learns what a "Claude Code launch" is. Future agent CLIs (codex, aider)
are sibling extensions, not host changes.

The extension's public API: `prepare({ channelId, title? })`:

Launches are **invitations into an existing conversation** — the channel is the anchor
and is never created here. If isolated work in a fresh context is wanted, that is the
existing subagent/fork machinery (which creates the task channel as part of spawning);
the linked agent is then invited to _that_ channel.

1. Resolve the **context from the channel**: channels are bound to exactly one
   `contextId`, so the session's context is the channel's context. Ensure/create the
   runtime **entity** (`kind: "session"`, `source: "claude-code"`) in that context;
   eagerly materialize the context folder.
2. Ensure the **linked-agent vessel** (§5): create/wake the `LinkedAgentWorker` DO for
   this entity and **invite it into the channel with the standard launch primitives**
   (`launchAgentIntoChannel`/`subscribeAgentToChannel` in
   `agentic-core/src/agent-launch.ts`) — the identical flow used for every other agent.
   From the channel's perspective nothing new exists: a `do:` participant subscribed
   with vessel semantics.
3. Mint the **agent credential** via `auth.mintAgentCredential` (§3.2), bound to
   entity + context + vessel. (The auth service allows this call for `extension`
   callers; the approval gate for first-time agent launches renders through
   `ctx.approvals`, same as shell-extension approvals.)
4. Write a **launch profile** — a generated directory under
   `<wsDir>/state/agent-launch/<entityId>/` containing:
   - `mcp.json` with the bridge entry:
     `{"mcpServers": {"vibestudio": {"command": "vibestudio", "args": ["claude", "channel-host"]}}}`
   - `settings.json` with the hooks wiring (§7.4) and policy defaults,
   - `env` (the variables below),
   - the `vibestudio-agent` skill made available to the session via settings — the
     context working tree is never polluted with `.claude/` config.
5. Return `{ entityId, contextId, channelId, vesselRef, contextFolder, env, argv }`
   where `argv` is the exact Claude Code invocation:
   `claude --channels server:vibestudio --dangerously-load-development-channels
--mcp-config <profile>/mcp.json --settings <profile>/settings.json`.

Injected environment (single naming scheme, consumed by bridge, CLI, and hooks):

```
VIBESTUDIO_SERVER_URL       HTTP(S) base URL of the workspace server
VIBESTUDIO_AGENT_TOKEN      agent:<agentId>:<token>   (never the device credential)
VIBESTUDIO_ENTITY_ID        runtime entity id
VIBESTUDIO_CONTEXT_ID       context id
VIBESTUDIO_CHANNEL_ID       primary channel id
```

`release({ entityId })` tears down: revoke credential, detach the vessel (agent goes
offline with proper presence; the vessel and its channel membership persist for
reattach unless the entity is retired).

### 4.3 Launch paths (all call the extension's `prepare`)

- **Terminal panel**: an "Open Claude Code" action on a conversation calls the
  extension over RPC (exactly how the terminal panel drives the shell extension today),
  then opens a PTY in `contextFolder` with the returned env and argv.
- **CLI**: `vibestudio claude [--channel <id>]` — calls the extension's `prepare`
  (generic service/extension RPC; the CLI stays Claude-agnostic apart from the command
  name), then execs Claude Code in the channel's context folder. With no flag, the
  channel is resolved from the current context (cwd marker / env, §6.2): its existing
  primary conversation channel. Starting a _new_ conversation is the existing
  conversation-creation flow, after which the agent is invited/launched into it.
- **Launch adapters (generic shell-extension hook)**: instead of hardcoding
  agent-specific upgrades into the shell extension, it gains one generic extension
  point: `shell.registerLaunchAdapter({ match, prepare })`. The claude-code extension
  registers an adapter matching the `claude` command line; when a bare `claude` is
  launched in a _context-scoped_ terminal session, the shell extension invokes the
  adapter, which resolves the context's primary conversation channel, runs `prepare`,
  and returns env/argv rewrites — "just typing `claude`" in a context terminal yields
  a fully connected agent. No matching adapter, or no conversation channel in the
  context → the session launches untouched (today's detection/tagging only); channels
  are never created as a side effect. `detectAgent`'s regex table folds into the same
  adapter registry (one mechanism for "recognize and optionally enrich agent
  launches"), with codex/aider adapters as future sibling extensions.

The snug server stays as-is: it is the PTY/UI affordance surface (badges, notify,
split), orthogonal to agent messaging. Claude Code sessions get both.

## 5. The linked-agent vessel (userland)

New userland worker: `workspace/workers/linked-agent/` — `LinkedAgentWorker extends
AgentWorkerBase`, declared in `vibestudio.yml` like any agent worker. It is a **full
agent vessel whose reasoning loop lives outside the system**: where `AiChatWorker` runs
Pi in-process, `LinkedAgentWorker` relays to an attached external process. Everything
else — identity (`do:{source}:LinkedAgentWorker:{entityId}`), `SubscriptionManager`,
channel envelopes via `onChannelEnvelope`, method provision via `onMethodCall`,
heartbeats, delivery cursors, fork-cloning, addressing (`shouldRespond` from the vessel
base) — is **inherited unchanged**. No channel-substrate changes; the
`participantIsAgentVessel` discriminator, roster, presence, and policies all just apply.

### 5.1 Attachment protocol

The vessel has an `attachment` state machine: `detached | attached(connectionRef)`.

- The bridge (§7) connects over WS with the agent credential and calls
  `vessel.attach({ sessionInfo })`. The RPC layer's entity binding (§3.2) is the
  authorization — only the credential minted for this entity can attach.
- While attached, the vessel forwards deliverable conversation input to the bridge via
  the platform event bus (`rpc.emitToConnection(callerId, connectionId, "linked-agent:event", …)`)
  — the same layer-1 emit path the channel DO uses for RPC participants, so no new
  transport machinery. The bridge acks with cursors; the vessel owns the durable
  delivery cursor exactly as vessels do today.
- Detach (explicit, connection drop, or heartbeat timeout) → the vessel publishes
  presence (agent offline/idle), buffers subsequent addressed input, and on reattach
  resumes from the cursor. Claude Code restarting in the same context folder reattaches
  to the _same_ vessel: conversation identity survives process churn.

### 5.2 What the vessel decides (semantics stay in userland)

- **Respond-or-not**: the vessel applies the standard addressing rules (`to`,
  `mentions`, `agentHops`, hop limit) _before_ forwarding to the bridge — the external
  session only ever sees input the agent should react to. A Pi vessel and a Claude Code
  session behave identically in a mixed conversation because it is literally the same
  code path.
- **Trajectory authorship**: the vessel converts attached-process reports (§7.4) into
  well-formed `agentic.trajectory.v1` sequences — turn framing, ids, idempotency keys —
  and publishes them. Exactly-once and fork-awareness come from the existing pipeline.
- **Method provision**: the vessel advertises `prompt({text})`, `interrupt()`,
  `status()` on the channel; calls are relayed to the bridge when attached, and fail
  with a clean "agent offline" terminal when detached.
- **Task duty**: when the channel is a task channel (subagent spawn, §8.2), the vessel
  owns `complete`-semantics and the terminal-settle contract with the parent.

## 6. CLI: transport, context discovery, `channel` group, and eval

### 6.1 Transport: standard RPC over HTTP, WS, and WebRTC

Everything in this plan rides the standard envelope-native RPC (`RpcEnvelope` →
`ServiceDispatcher`, push via the layer-1 event bus). The vessel↔bridge stream
(`linked-agent:event`) uses `rpc.emitToConnection` precisely so it inherits every
transport the RPC layer speaks. `RpcClient` (`src/cli/rpcClient.ts`) gains a third
mode: **WebSocket RPC** to `serverRpcWsUrl` (the server already serves WS RPC for
panels/app). Selection stays credential/URL-shaped, as today:

- one-shot request/response commands keep HTTP `POST /rpc` (loopback);
- anything needing server push — the bridge, `channel tail`, `logs --follow` — opens
  WS on loopback/LAN, or rides **WebRTC** when the credential carries a pairing blob
  (remote servers). `onEvent`/`stream` become transport-independent client API; the
  "push is WebRTC-only" special case is deleted.

**Remote agent auth**: the WebRTC redeemer (`createPairingRedeemer`) accepts the
`agent:<agentId>:<token>` prefix alongside `refresh:<deviceId>:<token>` — same
pipeline, one added prefix — so a bridge or in-session CLI works against a remote
workspace server identically to loopback.

**Placement note**: the common remote story needs no remote bridge — PTYs spawn on the
server host, so a remote human driving the terminal panel still gets a Claude Code
process on loopback WS with a real local context folder. A Claude Code process on a
_different_ machine gets full channel-agent connectivity and the full CLI over WebRTC —
and a real local working tree via **remote context mirrors** (§6.5).

### 6.5 Remote context mirrors

Fully-remote sessions get a local working tree, not a consolation prize. New CLI
surface, built on the primitives that already exist (content-addressed `WorktreeStore`,
`vcsContextRepoStates` targets, edit-op recording):

- `vibestudio context mirror [<contextId>] [dir]` — materializes the context's repos
  into a local directory over RPC: fetch `{repoPath, stateHash}` targets, stream CAS
  objects (new `mirror` service methods: `targets`, `objects` — read-side of the
  projector, exposed over the wire), write the tree, drop the
  `.vibestudio-context.json` marker so all CLI scoping (§6.2) works identically to a
  server-side context folder.
- `--watch` — a file watcher records local changes as **edit ops** against the context
  head via the existing `vcs.edit` flow (the same uncommitted-edit substrate every
  context uses), and applies inbound state-hash changes to the local tree. Conflict
  handling is the context's normal edit/commit semantics — the mirror adds no new
  merge model; concurrent edits surface exactly like two panels editing one context.
- Adoption mode (§8.3) composes: on a remote machine, `mirror --watch` + plugin launch
  inside the mirror directory yields the complete Tier-1 experience — local tools and
  `vibestudio fs/vcs` see the same tree, so the §8.3 divergence guard passes instead
  of warning.

### 6.2 Context discovery: cwd and env become first-class

Materialized context folders get a marker written at materialization time
(`WorkspaceVcs.ensureContextFolder`): `<contextFolder>/.vibestudio-context.json` →
`{ contextId, entityHint?, workspaceId, serverUrl }` (host-owned bookkeeping, excluded
from VCS projection/diffing).

CLI scope resolution precedence (implemented once in `resolveSessionScope`):

1. `--context <id>` / `--session <name>` explicit flags;
2. `VIBESTUDIO_CONTEXT_ID` (+ `VIBESTUDIO_AGENT_TOKEN` ⇒ also selects the agent
   credential and `agent` caller kind instead of the device credential);
3. cwd-upward search for `.vibestudio-context.json`;
4. the named default session file (today's behavior).

Net effect: inside a launched Claude Code session, **every** `vibestudio` invocation is
automatically scoped to the right server, credential, and context with zero flags. A
human `cd`-ing into a context folder gets the same.

### 6.3 New command group: `channel`

Fills the messaging gap for humans and agents alike. Host-facing wire schemas live in
`packages/service-schemas/src/channel.ts` — the defined interface the boundary
allows — relayed to the resolved channel DO; the host still never imports workspace
code:

```
vibestudio channel list                      # channels in this workspace/context
vibestudio channel history <id> [--after N]  # durable log read (paged)
vibestudio channel send <id> --text ... [--to @handle]
vibestudio channel tail <id>                 # live follow over WS
vibestudio channel roster <id>
```

### 6.4 Eval is the full-power surface — treat it that way

`vibestudio eval` already runs code **inside the system**: server-side in an `EvalDO`
(userland workerd), scoped to a session entity's context, able to import workspace
packages, `connectViaRpc` to channels, call services, and operate on the context tree.
For the Claude Code agent this is the answer to "full functionality of the running
server" — programmatic, composable, in-context — and the plan hardens it rather than
duplicating its powers as CLI subcommands:

- **Auto-scoping**: with §6.2, `vibestudio eval` inside a launched session binds to the
  session's own entity/context (env credential → entity binding) with zero flags; the
  persistent REPL scope is per-entity, so state survives across invocations within the
  session.
- **Policy**: `eval` is in the `agent` caller-kind grant set (§3.1). Eval executes with
  the _entity's_ scope, not the device's — the entity binding on the connection is what
  the EvalDO trusts.
- **Skill**: the `vibestudio-agent` skill (already shipped in dist) is extended with an
  eval-first section — canonical snippets for channel access, service calls, VCS
  operations, and structured output from inside the system — and is provisioned into
  every launched session via the launch profile (§4.2).

## 7. The bridge: `vibestudio claude channel-host`

The piece Claude Code spawns as its channel MCP server. **A CLI subcommand** — it stays
host-side in `src/cli/claude/` because it is now genuinely thin: stdio MCP on one side,
WS RPC + shared schemas on the other. All agentic semantics live in the vessel (§5); no
workspace imports, no boundary tension, no separate bin to ship.

One process, four relays:

### 7.1 Channel MCP server (stdio, toward Claude Code)

- Declares `claude/channel`, `claude/channel/permission`, and tools.
- `instructions` teach the session the contract: how `<channel source="vibestudio">`
  events look, that `say` replies to the conversation, that the `vibestudio` CLI —
  including in-system `eval` — is pre-scoped to this context, and what the meta
  attributes mean.

### 7.2 Vessel attachment (WS RPC, toward the workspace)

- Connects with `VIBESTUDIO_AGENT_TOKEN`, calls `vessel.attach`, receives
  `linked-agent:event` pushes, acks with cursors (§5.1).
- Inbound → Claude: each vessel-forwarded conversation event becomes
  `notifications/claude/channel`:

```
content: rendered message text (policy-rendered, mention-resolved by the vessel)
meta: { channel_id, seq, from, from_handle, kind, turn_id }
```

- Outbound tools exposed to Claude:
  - `say({ text, to?, mentions? })` → `vessel.say` → published on the channel
    (saliency `say`, idempotency key from the tool-call id);
  - `complete({ report, outcome })` → `vessel.complete` (present only when the vessel
    is on task duty, §5.2/§8.2).
    Secondary-channel messaging goes through `vibestudio channel send` (§6.3) or eval.

### 7.3 Permission relay → approvals service

`notifications/claude/channel/permission_request` → `vessel.requestPermission` → the
vessel files a first-class workspace approval (`approvals.requestExternal({ entityId,
capability: "claude-code.tool", operation, description, preview, requestId })`, a new
approvals-service method callable by `do`) **and** publishes an `invocation.waiting`
event on the channel, so the conversation shows "Claude Code wants to run `npm install`"
with inline approve/deny. The verdict resolves through the vessel back to the bridge as
`notifications/claude/channel/permission` `{request_id, behavior}`. One approval, two
surfaces, single source of truth. A detached/dead bridge auto-denies on timeout.

### 7.4 Trajectory reporting (hooks → vessel)

Claude Code hooks (configured in the launch profile's `settings.json`) call
`vibestudio claude emit <event>` — which relays to a local unix socket inside the launch
profile dir that the bridge listens on (hook processes never need their own server
round-trip or credentials). The bridge forwards to `vessel.ingestHookEvent`; the vessel
authors the trajectory (§5.2):

| Hook             | Trajectory effect (authored by the vessel)                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| SessionStart     | presence update (active); attach metadata (model, cwd)                                                              |
| UserPromptSubmit | `message.completed` (role user, source: terminal) — channel readers see the human side of the terminal conversation |
| PreToolUse       | `invocation.started` (tool name, input summary)                                                                     |
| PostToolUse      | `invocation.completed` / `invocation.failed`                                                                        |
| Stop             | final assistant message mirrored as `message.completed` (non-say saliency, §7.5) + `turn.closed`                    |
| SessionEnd       | detach + presence (offline)                                                                                         |

Result: a Claude Code session produces the same durable, forkable trajectory as a Pi
vessel, rendered by existing projections/cards with no UI special-casing beyond an
agent-kind badge.

### 7.5 Coexistence: interactive terminal + channel input

One serialized conversation, two input surfaces, two audiences. The primitives make
this safe; the rules below make it coherent.

**Serialization (given).** Claude Code runs one turn at a time. Terminal prompts start
turns directly; channel notifications queue inside Claude Code and are delivered
together at the next turn boundary — channel input never interrupts local work. In
front of that sit our two queues: the vessel's addressing gate (only input the agent
should react to is forwarded, §5.2) and the vessel's durable buffer while detached
(§5.1). Ordering end-to-end: channel seq → vessel cursor → MCP notification queue →
turn boundary.

**Audience separation (rule).** The terminal human sees everything locally. Channel
participants see the mirrored trajectory: the human's prompts (UserPromptSubmit), tool
invocations, turn framing, and — so the conversation isn't one-sided — the final
assistant message of each turn, mirrored as `message.completed` with **non-say
saliency**: visible in trajectory/cards, but not spoken into the conversation and not
waking other agents. `say` remains the deliberate act of addressing the channel; the
bridge's MCP `instructions` teach exactly this etiquette (terminal output → local
human; `say` → workspace).

**Turn state (both ways).** `turn.opened`/`turn.closed` publish regardless of which
surface initiated the turn, so channel participants and the UI always see the agent as
busy — including busy on behalf of its local human. Channel messages sent mid-turn
render as pending until the turn closes and delivery lands.

**Permission races (the one real dual-surface conflict).** In interactive mode the
terminal shows a permission prompt _and_ the relay forwards it (§7.3), so the local
human and workspace approvers can both answer. First verdict wins. Claude Code sends
no cancellation when the terminal answers, so the vessel cleans up: if PreToolUse
arrives for the pending request (tool proceeded ⇒ approved locally) or the turn closes
without the relay verdict being consumed, the vessel resolves the workspace approval
as "answered at the terminal". No dangling approval cards; a detached bridge still
auto-denies on timeout.

**Cursor/ack semantics.** The bridge acks the vessel when a notification has been
handed to Claude Code (queued), not when processed; `turn.closed` is the processed
marker. If the process dies between ack and processing, reattach replays from the last
turn boundary — duplicate delivery into a fresh turn is acceptable (events are
idempotently keyed and Claude sees them as context, not commands to re-execute
blindly); silent loss is not.

## 8. Composition with the existing agent system

### 8.1 Rosters, cards, UI

- Roster/presence: the linked agent is an ordinary `do:` vessel participant with a
  `claude-code` kind badge and attach/detach-driven presence.
- Chat: §7.4 events flow through existing projections and invocation cards unchanged.
- Terminal panel: context-scoped sessions show the context name; Claude-detected
  sessions link to the entity/channel (jump from terminal tab to conversation).

### 8.2 Claude Code as a subagent target (in scope)

`spawn_subagent` gains `agentKind: "claude-code"`: the parent vessel's spawn flow
creates the child context + task channel exactly as today, then the claude-code extension
performs a single subagent launch: it targets that channel, prepares/invites the linked
vessel, and privately runs headless `claude -p --no-tui --channels ...` in the child
context folder. The linked vessel's
task duty (`complete` → terminal-settle, §5.2) and §7.4 reporting feed the structured
progress pipeline unchanged — a Claude Code subagent shows up in the parent's
SubagentRunCard identically to a Pi subagent, including merge-back of its child
context. Fan-out, depth gating, and cancellation reuse the existing subagent-run
machinery without modification; kill/cancel releases the extension-owned headless launch.

The spawn's `config` maps onto the launcher CLI (extension-whitelisted, values
validated so they can't smuggle flags): `model`, `effort`
(low/medium/high/xhigh/max), `permissionMode`, `fallbackModel`, `maxBudgetUsd`.
Subagents launch with `--permission-mode auto` by default — the parent's spawn is
the authorization; a headless `-p` run blocked on interactive prompts would hang.
The subagent operating contract (shared `subagentRuntimePrompt`, the same text a
Pi child gets) rides the launch profile env (`VIBESTUDIO_SUBAGENT_*`) and the
bridge states it in the MCP instructions. Failure path: if the headless process
exits without calling `complete`, the extension reports the exit to the linked
vessel (`reportExternalExit`), which settles the parent's run as `failed` —
idempotent past a real complete, so runs never dangle as "running".

### 8.3 Sessions we didn't launch: adoption mode + plugin

The vessel is launch-agnostic, so foreign sessions (user's own tmux, VS Code terminal,
ssh) only need the front half rebuilt: discovery, credentials, configuration.

**Adoption mode (self-orchestrating bridge).** The launch profile becomes an
optimization, not a requirement. When `vibestudio claude channel-host` starts with no
`VIBESTUDIO_*` env, it adopts: discovery order env → cwd-upward
`.vibestudio-context.json` (→ that context's primary conversation channel) → paired
device credential (workspace/server). It calls the extension's `prepare` itself under
the device credential (`shell` caller; the extension's `prepare` policy admits
`shell`/`panel`), which mints the agent credential server-side and runs the standard
invitation — gated by a **first-adoption approval** in the workspace ("Claude Code
session on <host> wants to join conversation X as an agent"). Post-handshake it is
identical to a launched session: same vessel, trajectory, permission relay.

**The plugin (native distribution).** A `vibestudio` Claude Code plugin (own
marketplace repo) bundles: the channel entry (spawns `vibestudio claude channel-host`),
the hooks wiring (§7.4 without our settings injection), the `vibestudio-agent` skill,
and slash commands — `/vibestudio:connect [channel]`, `/vibestudio:status`,
`/vibestudio:pair` (interactive QR/deep-link pairing for unpaired machines, guided by
Claude). Install once, then `claude --channels plugin:vibestudio@<marketplace>` works
from any directory. Marketplace loading also retires the
`--dangerously-load-development-channels` requirement once out of research preview;
our terminal launch (§4.2) switches to the plugin reference too, so there is exactly
one packaging of the Claude-side glue.

**Degradation tiers** (channels only load at session start — design for tiers, not a
cliff; the skill teaches Claude to probe its tier and say what's missing):

- **Tier 0 — paired machine, no plugin, no restart**: CLI only. Full fs/vcs/eval plus
  `channel send/history` — polling-style participation; no push, no vessel presence,
  no permission relay.
- **Tier 1 — plugin active**: full linked-agent experience from any directory.
- **Tier 2 — our terminal launch**: Tier 1 plus context-scoped PTY, zero-setup env,
  and launch-adapter enrichment.

**cwd/context divergence guard.** A foreign session may sit outside the context
folder, so Claude's local file tools would touch different bytes than `vibestudio
fs/vcs` (server-side context tree). Adoption warns loudly on mismatch and requires an
explicit `--channel` to proceed; it never silently binds a session to a tree it isn't
looking at.

## 9. Breaking-changes register (for explicit review)

1. **`CallerKind`**: new `agent` kind in `@vibestudio/rpc` and
   `PRINCIPAL_KIND_REGISTRY`; every `ServicePolicy.allowed` list is re-reviewed and
   changed where granted. The parity guard forces the sweep.
2. **Shell extension API**: `open`/`exec`/session records gain `contextId`; cwd
   confinement becomes context-folder-relative for context sessions; `list()` payload
   shape changes. Terminal panel updated in the same change.
3. **CLI scope resolution**: precedence becomes flag > env > cwd marker > default
   session file. Behavior change for anyone relying on the implicit `default` session
   while standing in a context folder.
4. **CLI transport**: `RpcClient` unifies push (`onEvent`) across WS/WebRTC; the
   "push is WebRTC-only" special case is removed (internal API change).
5. **Auth surface**: new token prefix `agent:` in both the WS-auth redeemer and the
   WebRTC pairing redeemer (`createPairingRedeemer`); anything pattern-matching token
   prefixes must be updated. Entity binding stamped on agent-authenticated connections
   is new connection state.
6. **`ensureContextFolder`** now writes `.vibestudio-context.json` into every
   materialized context folder; the projector/diff layer must ignore it.
7. **Approvals service**: new `requestExternal` method callable by `do`; approval
   payloads gain the external-agent capability shape.
8. **`vibestudio.yml` / extension registry**: new `linked-agent` worker declaration;
   new `@workspace-extensions/claude-code` extension; extended `auth`/`approvals` host
   service schemas (no new host service — the orchestrator is the extension).
9. **Shell extension launch adapters**: `detectAgent`'s hardcoded regex table is
   replaced by the `registerLaunchAdapter` registry; the shell extension's public API
   gains the registration method, and session tagging flows through adapters.
10. **`spawn_subagent` tool schema**: gains `agentKind`; the subagent pipeline's
    child-bring-up branches on it. The claude-code extension owns the headless
    process launch privately; no generic runtime process surface is added.
11. **New `mirror` service** (host): read-side projection over the wire (`targets`,
    `objects`) + edit-op writeback path used by `context mirror --watch`.

(Channel substrate: **no breaking changes** — rev 2 deliberately leaves the participant
model, wire protocol, and schemaVersion untouched.)

## 10. Big-bang implementation

Everything in this plan is **one scope, one integration branch, one landing**. There
are no milestone boundaries, no partial ships, and no deferred items: the linked-agent
vessel, context terminals, the extension, the bridge, permission relay, `channel` CLI
group, adoption mode, the plugin, remote context mirrors, and the Claude Code subagent
target all merge in the same cut, with the breaking changes of §9 applied
simultaneously and replaced paths deleted outright (dead-code audit included in the
cut, per project policy).

**Workstreams** (parallelizable; dependency edges are for construction order only, not
shipping order):

- **W1 Identity & transport** — `agent` caller kind + full policy sweep + `agent ⊆ do`
  policy test, `auth.mintAgentCredential` + connection entity binding, WS transport in
  `RpcClient`, `agent:` prefix in both redeemers (WS + WebRTC).
- **W2 Linked-agent vessel** — `workspace/workers/linked-agent/`: attachment state
  machine, addressing gate, trajectory authorship, method provision, task duty,
  presence/cursor semantics.
- **W3 Context terminals & orchestration** — shell/panel `contextId`, launch-adapter
  registry (replacing `detectAgent`'s table), `@workspace-extensions/claude-code`
  (prepare/release, launch profiles), context markers, CLI scope precedence,
  `vibestudio claude`.
- **W4 Bridge & plugin** — `vibestudio claude channel-host` (MCP channel server,
  vessel attachment, hooks emit, say/complete, permission relay, adoption mode with
  discovery + divergence guard), the `vibestudio` Claude Code plugin (channel entry,
  hooks, skill, slash commands, pairing flow); §4.2 launch references the plugin.
- **W5 CLI surfaces** — `channel` group (list/history/send/tail/roster), remote
  context mirrors (`context mirror [--watch]`, `mirror` service), eval auto-scoping,
  skill rewrite (eval-first, tier probing).
- **W6 Approvals & UI** — `approvals.requestExternal`, dual-surface race resolution,
  roster/card badges, terminal↔conversation linking, SubagentRunCard parity for
  Claude Code subagents.
- **W7 Subagent target** — `spawn_subagent` `agentKind: "claude-code"`, extension-owned
  headless launch, terminal-settle integration.

Construction dependencies: W1 → everything; W2 → W4/W6/W7; W3 → W4/W7. W5 is
independent after W1.

**Acceptance (single cut).** The branch merges only when _all_ of the following pass
together, plus typecheck, unit suites, and the boundary checker:

1. CLI authenticates with an agent token over WS and over WebRTC against a remote
   server; `auth.getConnectionInfo` shows kind `agent` with entity binding; the
   `agent ⊆ do` policy test holds.
2. A linked vessel exchanges messages and method calls with a Pi vessel on a shared
   channel; detach/reattach preserves presence and cursor resume.
3. Launching from a conversation (panel action or `vibestudio claude --channel`)
   opens Claude Code in the channel's materialized context folder; `vibestudio vcs
status` and `vibestudio eval` inside it need no flags.
4. A panel message reaches the live session as a `<channel>` event; the reply lands in
   the conversation; the trajectory shows turns, tool invocations, and mirrored final
   messages; mid-turn channel messages queue to the next turn boundary.
5. A Claude Code `Bash` permission is approved from the workspace UI; a
   terminal-answered permission auto-resolves its workspace approval card.
6. On a machine with only a paired CLI, the plugin launch from inside a context folder
   joins after a workspace-side first-adoption approval; from a non-context directory
   it refuses without `--channel` and warns about divergence.
7. On a second machine over WebRTC: `context mirror --watch` + plugin launch inside
   the mirror yields a working session whose local edits appear as context edit ops in
   the workspace.
8. A Pi parent spawns a Claude Code subagent; progress folds into its SubagentRunCard;
   `complete` settles; the child context merges back.

## 11. Risks & open questions

- **Research-preview instability**: the `--channels` flag, notification methods, and the
  `--dangerously-load-development-channels` requirement may change. Containment: the
  bridge subcommand is the _only_ component that speaks the Claude-side protocol; the
  linked-agent vessel is Claude-agnostic and serves any externally-driven agent (codex,
  aider, future CLIs) with a different thin bridge. Pin the minimum Claude Code version
  in the extension's `prepare` and fail loudly. The containment is now structural:
  Claude-side knowledge exists in exactly two userland/client places — the claude-code
  extension and the bridge subcommand.
- **Org policy**: claude.ai Team/Enterprise accounts have channels off by default
  (`channelsEnabled`); `prepare` should surface a clear error, not a silent
  non-connection (channels drop events silently when blocked).
- **Hook fidelity**: hooks don't expose token-level streaming; the mirrored trajectory
  has message granularity, not delta granularity. This is a Claude Code platform
  constraint, not a scope cut — delta streaming would require Anthropic exposing it
  (or an SDK-driven in-vessel loop, which is a different product shape than linking
  external interactive sessions).
- **Prompt injection**: the vessel forwards channel content into a tool-bearing session.
  The enforced boundary is: vessel-side addressing gate, workspace-internal channel
  membership (paired identities only), the `agent` caller-kind ceiling, and the
  permission relay keeping a human on the trigger for sensitive tools. Externally-fed
  channels (webhook ingress → conversation) must not be permitted to address linked
  agents; that rule ships in this cut as part of the vessel's addressing gate, and
  relaxing it would require its own security review.
- **Resolved (2026-07-06)**: linked agents always join an _existing_ channel via the
  same invitation flow as other agents — the launch orchestrator never creates
  channels; the
  session's context derives from the channel. Fresh isolated contexts come only from
  the subagent/fork machinery.
- **Resolved (2026-07-06, rev 2)**: the agent's system identity lives in userland as a
  vessel DO; the CLI remains a thin device client, and in-system programmatic access is
  `vibestudio eval` (EvalDO, userland, entity-scoped) rather than linking userland code
  into the CLI.

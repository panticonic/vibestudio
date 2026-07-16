# Claude Code Sessions as First-Class Channel Agents

Status: IMPLEMENTED (2026-07-06, rev 3 — big-bang, all workstreams W1–W7 landed together;
typecheck host/userland/mobile, all unit suites, and the boundary checker green).
Rev 2 replaced the earlier `agent-external` participant-class redesign with a userland
**linked-agent vessel**: the Claude Code session's system identity is a real agent DO,
and the local process is a thin peripheral attached to it.
Rev 3 made the plan **big-bang**. Rev 4 deliberately removes plugin/adoption and linked
managed authoring after provenance recovery found that neither had an enforceable
invocation or filesystem boundary.
Rev 4 corrects a false managed-authoring claim discovered during provenance recovery:
linked processes have no canonical invocation-scoped mutation surface. They are
read-only reviewers/conversation peers until one exists; the server refuses agent-bound
managed mutation and eval without an exact causal invocation.
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
3. It has the `vibestudio` CLI auto-scoped for **read-only semantic orientation** and
   channel participation. Managed mutation and eval fail closed: a linked hook report is
   evidence of a Claude tool call, not an invocation-scoped execution authority.
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
- **Userland placement already has a front door: eval, but only from an exactly causal
  caller.** `vibestudio eval` executes TS/JS server-side in an `EvalDO`. An in-process
  agent tool invocation carries that edge automatically; a linked external CLI does not,
  so its eval call is refused rather than retroactively attributed from a hook.

Consequence for the channel integration: the Claude Code session's **system identity
must live in userland as a real agent vessel DO** (a _linked-agent vessel_, §5). The
vessel joins channels exactly the way every agent joins — invited, subscribed via the
shared launch primitives, `agent-do` semantics, response-owned subscription lifetime,
fork-cloning — and the local
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
| No exact linked mutation ingress                      | Keep managed paths read-only; do not invent identity transport (§6.6)  |

## 3. Identity & auth: the `agent` principal

### 3.1 New caller kind: `agent`

Add `agent` to `PRINCIPAL_KIND_REGISTRY` (`packages/shared/src/principalKinds.ts`,
`codeIdentity: false`) and to `CallerKind` in `@vibestudio/rpc`. Semantics: _an
autonomous external process acting as a workspace agent_ — distinct from `shell` (a
paired human-driven device) so service policies and approval flows can treat autonomous
tool use differently from a human at a prompt.

Every `ServicePolicy.allowed` list is reviewed once and updated deliberately (no blanket
grant). Initial grants allow channel participation and read methods on `fs`, `vcs`,
`docs`, `events`, `runtime`, and `serverLog`. Managed mutations and eval additionally
require an exact causal invocation and therefore reject linked CLI calls. Denied by default: auth admin, hostLifecycle,
workspace management. The compile-time parity guard forces the sweep.

Invariant: **the `agent` grant set must remain a subset of what `do` can reach.**
Agent-authored code already executes as `do` inside the EvalDO (§6.4), so `do` is the
agent's real capability ceiling; keeping `agent` ⊆ `do` guarantees the direct-CLI path
is never an escalation over the eval path (nor vice versa). A policy test asserts this
subset relation against the registered service definitions.

### 3.2 Entity-scoped agent credentials

Auth surface (`authService` + `DeviceAuthStore`):

- `auth.mintAgentCredential({ entityId, ttlMs? })` —
  callable by `extension` (the launch-orchestrator extension, §4.2) and `server`;
  deliberately _not_ by `shell`/`panel`/`agent`, so credentials are only ever minted
  through an orchestrator's prepare flow (with its `ctx.approvals` gate), never ad hoc
  by a device or by a running agent. Returns `{ agentId, agentToken }`.
  The credential authenticates as caller kind `agent`, principal `agent:<entityId>`.
  It stores only credential id, secret hash, entity id, and lifecycle timestamps.
  The live session entity owns `agentChannelId`, context, and owner; authentication
  derives the connection binding from that entity and rejects a retired or unbound
  session. No user, context, channel, scopes, intent, or authorship assertion rides
  in the credential.
- Lifecycle follows the entity: `retireEntity` revokes outstanding agent credentials.
  Tokens are refresh-style (same redeemer pipeline as `refresh:<deviceId>:<token>`,
  new prefix `agent:<agentId>:<token>`), redeemed at WS auth exactly like device
  credentials — one auth model everywhere, per the attachable-server design.
  Mint rotates the entity's single credential and its ephemeral bearer token.

This removes any temptation to hand the raw device credential of the human's CLI pairing
to an autonomous process. The same credential powers both the bridge (§7) and every
`vibestudio` CLI invocation inside the session.

## 4. Context-scoped terminal sessions & the launch orchestrator

### 4.1 Shell extension: contexts become a first-class parameter

- `shell.open()` / `shell.exec()` gain `contextId?: string`. When set, the extension asks
  the host to materialize the folder (new extension-host capability
  `workspace.ensureContextFolder(contextId)`, backed by the host's narrow
  exact-state projection effect) and confines cwd resolution to
  `resolveWithin(contextFolder, parsed.cwd)` instead of the workspace root.
- Session records and `list()` output carry `contextId`; in context sessions the
  Git-branch probe is replaced by semantic context status (display the current
  working-head summary via `vcs.status({ contextId })`, not `.git` reads).
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
   runtime **entity** (`kind: "session"`, `source: "claude-code"`) in that context.
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
4. Return one strict, portable **launch declaration**:
   `{ protocol: "vibestudio.claude-launch.v1", launchId, executable: "claude",
environment }`. It contains semantic identity and optional subagent duty only. It
   contains no server URL, context folder, profile directory, skills directory, or
   already-expanded argv.
5. The machine that will actually execute Claude validates its local Claude Code
   version and materializes the declaration below its own disposable launch-state
   root. That local profile contains `mcp.json`, hook-only `settings.json`, and a
   mode-`0600` diagnostic `env.json`; its argv points only at those local files. The
   materializer injects the selected local hub/WebRTC route and profile directory.
   Workspace skills are served as authenticated MCP resources by the bridge. The launcher removes the profile and calls
   `release` on exit, launch failure, context mismatch, or denied terminal approval.

Portable environment (consumed by bridge, CLI, and hooks):

```
VIBESTUDIO_AGENT_TOKEN      agent:<agentId>:<token>   (never the device credential)
VIBESTUDIO_ENTITY_ID        runtime entity id
VIBESTUDIO_CONTEXT_ID       context id
VIBESTUDIO_CHANNEL_ID       primary channel id
VIBESTUDIO_VESSEL_REF       linked vessel target
```

`VIBESTUDIO_SERVER_URL` and `VIBESTUDIO_LAUNCH_PROFILE` exist only in the locally materialized process environment.
They are never transported in `prepare`.

`release({ entityId, launchId })` revokes only that exact preparation generation's
credential and removes only its extension-local materialization. A CLI owns and
removes its exact local materialization. An older process exiting cannot revoke or
delete a newer launch for the same entity. The vessel goes
offline through its normal attachment lifecycle; the vessel and channel membership
persist for reattach unless the entity is retired.

### 4.3 Launch paths (all call the extension's `prepare`)

- **Terminal panel**: an "Open Claude Code" action on a conversation calls the
  extension over RPC (exactly how the terminal panel drives the shell extension today),
  materializes the declaration on that host, then opens a PTY in the context projection.
  The generic launch-adapter result carries one cleanup action that the shell invokes
  exactly once on exit/disposal and also on approval or spawn failure.
- **CLI**: `vibestudio claude [--channel <id>]` — calls the extension's `prepare`
  (generic service/extension RPC; the CLI stays Claude-agnostic apart from the command
  name), verifies the returned context identity against the nearest local binding,
  materializes locally, and execs Claude Code in that binding's directory. Even with
  `--channel`, the launcher requires a local binding so Claude's file tools cannot be
  silently pointed at a different tree. With no flag, the channel is resolved from the
  binding's existing primary conversation channel. Starting a _new_ conversation is the existing
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
subscription resources, delivery cursors, fork-cloning, addressing (`shouldRespond` from the vessel
base) — is **inherited unchanged**. No channel-substrate changes; the
`participantIsAgentVessel` discriminator, roster, presence, and policies all just apply.

### 5.1 Response-owned bridge protocol

There is no attachment lease, heartbeat, detach command, connection watcher, or private
event callback. The bridge calls `vessel.openBridge({ sessionInfo })`; the returned
NDJSON response **is** the attachment resource.

- The first record is exactly one `subscribed` ACK containing the durable cursors and
  replay count. No event may precede it. Later records carry deliverable input and
  permission verdicts.
- Cancelling the response reader, losing its routed RPC connection, or closing the
  process releases that exact bridge generation. A replacement `openBridge` fences and
  closes the prior generation atomically; a late cancel from the old reader cannot
  detach the new one.
- The vessel derives online presence from the currently live response. It buffers
  addressed input durably while no response exists and replays from the last processed
  turn boundary when a new response opens. Claude Code restarting for the same entity
  reaches the same vessel and conversation history without preserving a synthetic
  attachment record.
- The RPC layer's entity binding (§3.2) authorizes `openBridge`; it is not authorship or
  intent. Intent remains walkable through the canonical source message → turn → tool
  invocation chain (§7.4).

### 5.2 What the vessel decides (semantics stay in userland)

- **Respond-or-not**: the vessel applies the standard addressing rules (`to`,
  `mentions`, `agentHops`, hop limit) _before_ forwarding to the bridge — the external
  session only ever sees input the agent should react to. A Pi vessel and a Claude Code
  session behave identically in a mixed conversation because it is literally the same
  code path.
- **Causal trajectory projection**: the vessel converts attached-process reports
  (§7.4) into well-formed `agentic.trajectory.v1` sequences — exact triggering message,
  turn framing, tool request, ids, and idempotency keys — and publishes them. It does
  not accept or transport an "author" claim; authorship, intent, and blame are queries
  over those edges. Exactly-once and fork-awareness come from the existing pipeline.
- **Method provision**: the vessel advertises `prompt({text})`, `interrupt()`,
  `status()` on the channel; calls are relayed to the bridge when attached, and fail
  with a clean "agent offline" terminal when detached.
- **Task duty**: when the channel is a task channel (subagent spawn, §8.2), the vessel
  owns `complete`-semantics and the terminal-settle contract with the parent.

## 6. CLI: transport, context discovery, `channel` group, and eval

### 6.1 Transport: standard RPC over HTTP, WS, and WebRTC

Everything in this plan rides the standard envelope-native RPC (`RpcEnvelope` →
`ServiceDispatcher`). The vessel↔bridge link is an ordinary routed streaming RPC
response, so its lifetime and cancellation inherit every transport the RPC layer
speaks without a second callback protocol. `RpcClient` (`src/cli/rpcClient.ts`) gains a third
mode: **WebSocket RPC** to `serverRpcWsUrl` (the server already serves WS RPC for
panels/app). Selection stays credential/URL-shaped, as today:

- one-shot request/response commands keep HTTP `POST /rpc` (loopback);
- anything needing a long-lived response — the bridge, `channel tail`, `logs --follow`
  — opens WS on loopback/LAN, or rides **WebRTC** when the credential carries a pairing
  blob (remote servers). `stream` is the transport-independent client API; resource
  loss is response termination, not an out-of-band liveness opinion.

**Remote agent auth**: the WebRTC redeemer (`createPairingRedeemer`) accepts the
`agent:<agentId>:<token>` prefix alongside `refresh:<deviceId>:<token>` — same
pipeline, one added prefix — so a bridge or in-session CLI works against a remote
workspace server identically to loopback.

**Placement note**: the common remote story needs no remote bridge — PTYs spawn on the
server host, so a remote human driving the terminal panel still gets a Claude Code
process on loopback WS with a real local context folder. A Claude Code process on a
_different_ machine gets full channel-agent connectivity and the full CLI over WebRTC —
with the same read-only linked policy — plus a local snapshot export via **remote
context mirrors** (§6.5).

### 6.5 Remote context mirrors

Fully remote sessions can export a local snapshot. The CLI surface is a
projection client for the canonical semantic workspace state machine
defined in
[provenance-aware-diff-merge-plan.md](provenance-aware-diff-merge-plan.md),
not a second context-local revision protocol:

- `vibestudio context mirror [<contextId>] [dir]` — resolves the context's exact
  working head, pages its repository projections,
  streams referenced content objects through a narrow projection service,
  writes the tree, and drops the
  `.vibestudio-context.json` binding so all CLI scoping (§6.2) works identically to a
  server-side context folder. The command stops there: it does not infer
  semantic edits by watching arbitrary filesystem activity. A linked agent may
  inspect this projection but cannot author managed changes through it.

### 6.6 Managed authoring boundary

There is no supported linked managed-mutation path in this cut. The exact native
Claude `PreToolUse` hook is durably recorded, including its structural `tool_input`,
but a hook is an observation: it neither executes the tool through the semantic VCS
nor scopes a later CLI subprocess. The existing canonical mutation surface is the
in-process agent tool runner, which automatically wraps service calls in the exact
trajectory invocation. It cannot be narrowly reused by this external process without
adding a second tool/identity transport.

Therefore:

- agent-bound managed `fs`/`vcs` mutations and `eval` without a causal parent fail
  closed at the service boundary;
- linked instructions expose semantic reads and channel participation, not an
  edit/commit workflow;
- native Edit/Write/Bash changes to a materialized or mirrored repository are merely
  dirty projection bytes and are unsupported;
- no env-carried invocation ID, ambient current-invocation lookup, filesystem watcher,
  or post-hoc change inference is added.

This deliberately loses linked implementation/subagent functionality. Restoring it
requires one canonical invocation-scoped MCP mutation surface that executes the
semantic operation itself; the hook path remains provenance observation only.

### 6.2 Context discovery: cwd and env become first-class

Materialized context folders get one strict public identity binding written at
materialization time (`WorkspaceVcs.ensureContextFolder`):

```json
{
  "protocol": "vibestudio.context-binding.v1",
  "workspaceId": "<durable workspace identity>",
  "contextId": "<durable context identity>"
}
```

`<contextFolder>/.vibestudio-context.json` contains exactly those fields. It has no
endpoint, credential, entity hint, projection generation, semantic receipt, or
optional legacy shape. Reach is resolved from the selected paired credential's
current hub/WebRTC route; an extension process receives its current gateway through
`VIBESTUDIO_EXTENSION_GATEWAY_URL`. A binding whose `workspaceId` differs from the
credential is rejected before RPC. Because this file is only a durable locator, it
does not duplicate agent intent or attribution: those remain projections over the
semantic command's causal provenance edges.

The host separately keeps disposable crash-recovery state in
`<contextFolder>/.gad/context-materialization.json`. That private receipt records the
last materialized semantic basis and repository targets so the host can detect a
changed basis, remove retired projections, and answer mirror-target reads after a
restart. It is not a CLI protocol, is never used for reach, and may be rebuilt by
rematerializing semantic state. Both files are excluded from VCS projection/diffing.

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

### 6.4 Eval remains in-process and causally scoped

`vibestudio eval` runs code inside an `EvalDO`, but placement alone is not provenance.
An agent-bound eval must arrive through an exact trajectory invocation, just like a
managed VCS mutation. In-process agents receive that edge from their tool runner;
linked CLI subprocesses do not. Linked eval therefore fails closed. Paired direct
human/device callers retain their authorized eval surface, and the generic CLI docs
describe it, but linked bridge instructions do not advertise it.

## 7. The bridge: `vibestudio claude channel-host`

The piece Claude Code spawns as its channel MCP server. **A CLI subcommand** — it stays
host-side in `src/cli/claude/` because it is now genuinely thin: stdio MCP on one side,
WS RPC + shared schemas on the other. All agentic semantics live in the vessel (§5); no
workspace imports, no boundary tension, no separate bin to ship.

One process, four relays:

### 7.1 Channel MCP server (stdio, toward Claude Code)

- Declares `claude/channel`, `claude/channel/permission`, and tools.
- `instructions` teach the session the contract: how `<channel source="vibestudio">`
  events look, that `say` replies to the conversation, that read-only CLI discovery is
  pre-scoped to this context, that mutation/eval fail closed without an in-process
  causal invocation, and what the meta attributes mean.

### 7.2 Vessel response (streaming RPC, toward the workspace)

- Connects with `VIBESTUDIO_AGENT_TOKEN` and holds `vessel.openBridge`'s response open.
  It requires the ACK before binding the hook socket, consumes data records in order,
  and acks durable delivery cursors (§5.1).
- Transport recovery opens one replacement response after the routed connection is
  restored. An unexpected response end is fatal to the channel-host process; there is
  no independent application retry loop that could mask a broken transport.
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

| Hook             | Trajectory effect (authored by the vessel)                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart     | presence update (active); attach metadata (model, cwd)                                                                            |
| UserPromptSubmit | exact `message.completed` (role user, source: terminal), then `turn.opened` triggered by that message                             |
| PreToolUse       | `invocation.started` with tool name and exact structural `tool_input` in `request`                                                |
| PostToolUse      | `invocation.completed` / `invocation.failed` with a bounded diagnostic output summary, not a claim of exact result retention      |
| Stop             | final assistant message mirrored as `message.completed` (non-say saliency, §7.5) + `turn.closed`; rejected if no trigger was seen |
| SessionEnd       | detach + presence (offline)                                                                                                       |

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
render as pending until the turn closes and delivery lands. A received channel message
is not mirrored: the linked `turn.opened` points directly to that canonical message ID,
including after detached replay. A terminal prompt stores its exact prompt message first
and points the turn to it. Thus message → turn → invocation is walkable without a second
prompt copy.

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
SubagentRunCard identically to a Pi subagent, including semantic review and
integration of its child context. Fan-out, depth gating, and cancellation reuse
the existing subagent-run machinery without modification; kill/cancel releases
the extension-owned headless launch.

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

### 8.3 Controlled launches only

An MCP child cannot retrofit filesystem containment around an already-running Claude
parent. Plugin/adoption mode is therefore deleted, including its per-context hook
socket and warning-based divergence path. `channel-host` requires the complete
launcher profile; without it, it refuses and directs the user to `vibestudio claude`.

The launcher executes Claude through Linux bubblewrap. The host filesystem and exact
context projection are read-only mounts; `/tmp` and one disposable profile-local
`VIBESTUDIO_LINKED_SCRATCH` directory are writable. Native Edit/Write/Bash attempts
against the context receive `EROFS`, while scratch stays usable. The launch fails closed
when bubblewrap is absent or on a platform without an audited backend. `chmod`, Claude
permission mode, and prompt instructions are not treated as containment.

There are now two explicit states only:

- paired CLI, with no linked vessel or linked trajectory;
- controlled `vibestudio claude` launch, with vessel, exact hook provenance, and
  OS-enforced read-only projection.

## 9. Breaking-changes register (for explicit review)

1. **`CallerKind`**: new `agent` kind in `@vibestudio/rpc` and
   `PRINCIPAL_KIND_REGISTRY`; every `ServicePolicy.allowed` list is re-reviewed and
   changed where granted. The parity guard forces the sweep.
2. **Shell extension API**: `open`/`exec`/session records gain `contextId`; cwd
   confinement becomes context-folder-relative for context sessions; `list()` payload
   shape changes. Terminal panel updated in the same change.
3. **CLI scope resolution**: precedence becomes flag > env > cwd binding > default
   session file. Behavior change for anyone relying on the implicit `default` session
   while standing in a context folder. The only supported paired-device credential
   schema stores the selected durable `workspaceId`; named session records do the same
   and compare identity by `serverId` + `workspaceId`, never by mutable workspace name.
   Earlier credential, session, and endpoint-bearing binding shapes are rejected rather
   than migrated.
4. **CLI transport**: `RpcClient.stream` carries response-owned resources across
   WS/WebRTC; the linked bridge no longer has a transport-specific push callback
   (internal API change).
5. **Auth surface**: new token prefix `agent:` in both the WS-auth redeemer and the
   WebRTC pairing redeemer (`createPairingRedeemer`); anything pattern-matching token
   prefixes must be updated. Entity binding stamped on agent-authenticated connections
   is new connection state.
6. **Context projection protocol**: `ensureContextFolder` writes the strict
   `vibestudio.context-binding.v1` identity binding into every materialized context
   folder, while its disposable materialization receipt lives privately under
   `.gad/`. The projection epoch is bumped; no endpoint-bearing marker or legacy
   parser remains. The projector/diff layer ignores both host-owned files.
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
11. **New narrow mirror projection service** (host): streams content objects
    currently reachable from the agent's host-bound context. Reachability is
    derived for each request, so it does not depend on a prior discovery call or
    an in-memory authorization registry. Semantic writes are not part of this
    service.

(Channel substrate: **no breaking changes** — rev 2 deliberately leaves the participant
model, wire protocol, and schemaVersion untouched.)

## 10. Big-bang implementation

Everything in this plan is **one scope, one integration branch, one landing**. There
are no compatibility paths: the linked-agent vessel, context terminals, extension,
contained bridge, permission relay, `channel` CLI group, remote context mirrors, and
Claude Code reviewer-subagent target merge in the same cut, with §9 applied
simultaneously and replaced paths deleted outright (dead-code audit included in the
cut, per project policy).

**Workstreams** (parallelizable; dependency edges are for construction order only, not
shipping order):

- **W1 Identity & transport** — `agent` caller kind + full policy sweep + `agent ⊆ do`
  policy test, `auth.mintAgentCredential` + connection entity binding, WS transport in
  `RpcClient`, `agent:` prefix in both redeemers (WS + WebRTC).
- **W2 Linked-agent vessel** — `workspace/workers/linked-agent/`: one response-owned
  bridge resource, addressing gate, causal trajectory projection, method provision,
  task duty, presence/cursor semantics.
- **W3 Context terminals & orchestration** — shell/panel `contextId`, launch-adapter
  registry (replacing `detectAgent`'s table), `@workspace-extensions/claude-code`
  (prepare/release, launch profiles), context bindings, CLI scope precedence,
  `vibestudio claude`.
- **W4 Contained bridge** — `vibestudio claude channel-host` (MCP channel server,
  response stream, hooks emit, say/complete, permission relay) behind one fail-closed
  bubblewrap launch. Unmanaged adoption/plugin paths are deleted.
- **W5 CLI surfaces** — `channel` group (list/history/send/tail/roster), remote
  context snapshot export (`context mirror`, `mirror` service), explicit linked
  read-only boundary, and skill rewrite (tier probing).
- **W6 Approvals & UI** — `approvals.requestExternal`, dual-surface race resolution,
  roster/card badges, terminal↔conversation linking, SubagentRunCard parity for
  Claude Code subagents.
- **W7 Subagent target** — `spawn_subagent` `agentKind: "claude-code"`, extension-owned
  headless reviewer/orienter launch, terminal-settle integration. It cannot implement
  managed changes until §6.6 has one canonical mutation surface.

Construction dependencies: W1 → everything; W2 → W4/W6/W7; W3 → W4/W7. W5 is
independent after W1.

**Acceptance (single cut).** The branch merges only when _all_ of the following pass
together, plus typecheck, unit suites, and the boundary checker:

1. CLI authenticates with an agent token over WS and over WebRTC against a remote
   server; `auth.getConnectionInfo` shows kind `agent` with entity binding; the
   `agent ⊆ do` policy test holds.
2. A linked vessel exchanges messages and method calls with a Pi vessel on a shared
   channel; response cancellation removes presence, a replacement response resumes the
   cursor, and cancellation of the old generation cannot tear down the replacement.
3. Launching from a conversation (panel action or `vibestudio claude --channel`)
   opens Claude Code in the channel's materialized context folder; read-only
   `vibestudio vcs status` needs no flags, while eval and managed mutations refuse
   without an exact causal invocation.
4. A panel message reaches the live session as a `<channel>` event; the reply lands in
   the conversation; the trajectory shows turns, tool invocations, and mirrored final
   messages; mid-turn channel messages queue to the next turn boundary.
5. A Claude Code `Bash` permission is approved from the workspace UI; a
   terminal-answered permission auto-resolves its workspace approval card.
6. An unmanaged `channel-host` refuses before adopting identity. A controlled launch
   proves native context writes fail with `EROFS` and explicit scratch writes pass.
7. On a second machine over WebRTC: `context mirror` exports the exact context
   snapshot and establishes zero-flag read-only CLI scoping; managed mutation is
   refused without a watcher or filesystem reconstruction fallback.
8. A Pi parent spawns a Claude Code reviewer subagent; progress folds into its
   SubagentRunCard; `complete` settles; any implementation request returns to the
   in-process parent.

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
- **Corrected (2026-07-15, rev 4)**: the agent's system identity lives in userland as a
  vessel DO, but identity does not supply mutation causality. Linked eval and managed
  mutation remain unavailable until one invocation-scoped MCP execution surface exists.

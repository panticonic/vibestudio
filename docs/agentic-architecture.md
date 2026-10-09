# Agentic Architecture: Channels, Durable Work, and In-Process Pi

> **Landed model (2026-07-25).** GAD is semantic authority; channel and agent
> SQLite queues are reconstructible durable projections; alarms schedule
> deadlines and recovery only; and the host `DurableWorkDriver` owns long
> execution. Historical detail later in this document does not override
> `docs/agentic-hot-path-work-dispatch-plan.md`.

## Overview

Vibestudio's agentic system is a three-part server-side architecture. Pi
(`@mariozechner/pi-coding-agent`) runs **in-process** inside each agent
worker DO — there is no harness child process layer.

```
Panel          Channel DO             Host driver             Agent vessel / GAD
  │ publish        │                       │                         │
  │───────────────►│ append log + queue    │                         │
  │                │── work-ready hint ───►│                         │
  │                │◄── claim batch ───────│                         │
  │                │                       │── acceptChannelBatch ──►│ local inbox commit
  │                │◄── exact settlement ──│                         │
  │                │                       │── claim inbox/effect ──►│ fold + Pi/tool execution
  │                │                       │                         │── append outcome to GAD
  │◄── log event ──│◄───────────────────────────────────────────────│
```

- **Channel DO** — workspace-authored service. Forkable
  history, `this.sql`-backed message storage, participant roster, ephemeral and
  persisted message routing. Enforces participant handle uniqueness so the
  channel method tools can be named after the owning participant's handle.
- **Agent vessel DO** —
  `workspace/packages/agentic-do/src/agent-vessel.ts`. Owns folded loop state
  per subscribed channel and executes host-held inbox/effect claims. The pure
  loop derives deterministic intentions; Pi remains in-process.
- **Host durable-work driver** —
  `src/server/services/durableWorkDriver.ts`. Consumes disposable receipts,
  scans the owner registry for recovery, and drives bounded,
  generation-fenced claims outside alarm activations.
- **GAD** — owns trajectory order, head CAS, intentions, and terminal events.
  Local inbox and effect rows are projections.

## Key design principle: trajectory events are the transcript source

Pi owns live provider/session execution inside a turn. Durable transcript state
is represented as `agentic.trajectory.v1` events:

- `message.started`, `message.delta`, `message.completed`, `message.failed`
- `invocation.started`, `invocation.output`, `invocation.completed`, etc.
- `turn.opened`, `turn.waiting`, `turn.closed`

The chat UI consumes persisted channel envelopes with
`payloadKind: "agentic.trajectory.v1/event"` and reduces them through
`@workspace/agentic-protocol` into the rendered transcript. Signal messages are
still used for transient extension/status UI, but not as the authoritative chat
transcript.

### Channel event flow

1. User/panel messages are published as durable `message.completed` events.
2. `acceptChannelBatch` atomically admits incarnation-addressed structured
   delivery; the host claims one inbox transition per channel lane.
3. `AgentLoopDriver` folds the trajectory and executes claimed Pi model, tool,
   and turn transitions.
4. The driver appends canonical trajectory outcomes to GAD; selected events
   publish to the channel from that authoritative append.
5. `useChannelMessages()` subscribes to replay + live channel events and
   reduces them into `ChatMessage[]`.

## Application-owned orchestration

Channels and trajectories provide durable conversation and effect facts; they
do not make an agent authoritative for application state. Agentic applications
should split responsibilities explicitly:

- deterministic application code owns state, legal transitions, resource
  accounting, invariants, and terminal outcomes;
- agents interpret natural language, explain tradeoffs, and request narrow
  methods against that authority;
- method implementations authenticate `callerId` and enforce role authority
  independently of prompts;
- coordinators reread live state before resolving natural references and route
  addressed work without acquiring mutation authority.

In a multi-agent channel, strict addressed delivery is the safe default.
Unmentioned human input should have one product-chosen recipient, while an
explicit mention overrides that default. Products should gate input until the
chosen recipient identities are live instead of accepting messages into an
unroutable state.

Application transitions sometimes require a conversational continuation, such
as notifying a coordinator to open the next round. That continuation is an
effect of the transition, not disposable UI. Persist the new state and a pending
addressed directive together, publish it with a transition-derived idempotency
key, and clear it only after successful publication. Redrive the recorded
directive after reload or hibernation. Applications that must progress without
an open panel should place this authority and outbox in a Durable Object;
panel-local state is sufficient only when an open panel is the intended owner.

The stock `@workspace/agentic-chat` UI keeps capability selection separate from
presentation. Feature selection controls which browser methods exist, while
product renderers may preserve, wrap, replace, or elide stock transcript,
header, delivery, and composer surfaces. Hiding routine tool activity must not
remove canonical events or the product's path to inspect failures.

## DO Base Classes

**DurableObjectBase** — generic DO foundation (~150 lines).
Location: `workspace/packages/runtime/src/worker/durable-base.ts`

**AgentVesselBase** — event-sourced Pi-native agent base extending
DurableObjectBase.
Location: `workspace/packages/agentic-do/src/agent-vessel.ts`

### Customization hooks

| Hook                           | Default (`AgentVesselBase` → `AgentWorkerBase`)                                         | Purpose                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `getDefaultModel()`            | `AgentWorkerBase`: `DEFAULT_AGENT_MODEL_REF` (`packages/model-catalog/src/catalog.ts`)  | Default model id in `provider:model` format; subscription config can override per channel |
| `getDefaultThinkingLevel()`    | `"medium"`                                                                              | Default thinking level; state/config can override per channel                             |
| `getDefaultApprovalLevel()`    | `2`                                                                                     | Stored approval UX setting (see Approval)                                                 |
| `getDefaultRespondPolicy()`    | vessel `"mentioned-or-followup"`; `AgentWorkerBase` `"all"`                             | Which channel messages start a turn                                                       |
| `getDefaultRespondFrom()`      | `[]`                                                                                    | Participants the respond policy is restricted to                                          |
| `shouldProcess(event)`         | Completed agentic messages from other participants                                      | Filter incoming channel events                                                            |
| `buildTurnInput(event)`        | Concatenated text blocks                                                                | Transform to turn input                                                                   |
| `getParticipantInfo()`         | abstract                                                                                | Channel identity + advertised methods                                                     |

The final prompt is composed from the Vibestudio base prompt,
`workspace/meta/AGENTS.md`, the generated skill index, and optional
subscription prompt config. Workspace skills are discovered from top-level
`SKILL.md` files in workspace repos; `workspace/skills/` is reserved for
cross-repo workflow skills or skills that are themselves reusable code packages.

### Durable Object SQL Tables

| Table               | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| `state`             | Key-value configuration and operational metadata                |
| `subscriptions`     | Channel membership and exact vessel incarnation                 |
| `agent_inbox_queue` | Incarnation-fenced channel and internal transitions with leases |
| `effect_outbox`     | Deterministic effect projection with owner/generation/expiry    |
| `subagent_runs`     | Durable subagent supervision index                              |

Conversation and turn authority does not live in those tables; it is folded
from GAD. Successful progress never waits for an alarm floor, stale sweep,
lease expiry, or recovery scan.

## Where State Lives

Workspace and framework state lives in Durable Objects:

- Agent and channel workers own their own `this.sql` schema.
- `EvalDO` runs sandbox eval server-side and stores per-owner REPL scope (one per caller, behind the `eval` service).
- `WorkspaceDO` stores panel tree state and panel search FTS (replaced the former `PanelStoreDO`).
- `BrowserDataDO` stores imported browser data and history FTS.
- `WebhookStoreDO` stores webhook ingress subscriptions.

See `docs/architecture/storage.md` for object key conventions and internal DO
registration details.

## Hermetic sandbox

The worker does not use Pi's auto-discovery. The workspace prompt
(`workspace/meta/AGENTS.md`) and skill index are read via the `workspace.*`
RPC service (`workspace/packages/harness/src/resource-loader.ts`) and composed
into the system prompt; there are no Pi extension factories. Every tool the
agent sees is a `ToolRegistration` built by the worker for the channel.

## Agent tools on a channel

`AgentWorkerBase` (`workspace/packages/agentic-do/src/agent-worker-base.ts`)
assembles the tool list per channel from the roster snapshot captured for that
turn:

- **Peer methods** — `createNativeChannelMethodTools`
  (`workspace/packages/agentic-do/src/native-channel-method-tools.ts`, called
  through `AgentVesselBase.createAdvertisedChannelTools` in `agent-vessel.ts`)
  turns every method a roster participant advertises with a `parameters` schema
  (`captureChannelMethodOffers` in `workspace/packages/pubsub/src/method-offers.ts`)
  into a real tool. A method offered by one participant keeps its name; the
  same method with an identical schema from several participants is one tool
  with a required `target_participant` selector; differing offers, or names
  that collide with local tools, become `<method>_<handle>`. Each tool keeps
  the exact offering participant ids, so a later roster change cannot
  redirect an in-flight call.
- **`ask_user`** — `createAskUserTool` (only when a human is askable) calls
  `executeNativeAskUser` in `agent-vessel.ts`, which builds a `feedback_form`
  (select/multiSelect options, or one string field) and sends it to the
  captured human (`kind: "user"`) participants, or to the one named by `to`
  (`@handle` or participant id; an unknown target fails rather than
  broadcasting).

## Panel-provided UI tools

The chat panel advertises its own methods, which agents see as tools through
the mechanism above: `inline_ui`, `load_action_bar`, `inspect_card`,
`client_eval` (`workspace/packages/agentic-chat/hooks/useAgenticChat.ts`) and
`feedback_form` / `feedback_custom`
(`hooks/features/useChatFeedback.ts`). Model-facing guidance lives in
`workspace/skills/visualize` and `workspace/skills/sandbox`.

When an inline UI, action bar, or card fails to render or rejects its props,
`UiFeedbackReporter` (`agentic-chat/components/UiFeedbackReporter.tsx`)
publishes a `ui.feedback` event to the authoring participant, deduplicated by
`occurrenceKey`. The agent's native channel session
(`agentic-do/src/native-channel-session.ts`) admits it: a first failure of an
ordinary turn's output starts a repair turn when the agent is idle, or follows
its current turn; failures of a repair turn's own output, and later failures of
an already repaired turn, wait as notes for the agent's next turn.

## Approval

Real permission prompts are host-issued cards for sensitive operations
(out-of-band app approvals). The per-agent `approvalLevel` (0 ask all, 1 auto
safe, 2 full auto; `agentic-do/src/agent-config.ts`, `setApprovalLevel`) is
stored as a UX setting and read by the chat UI
(`workspace/packages/tool-ui/src/hooks/useToolApproval.ts`); the agent worker
does not gate individual tool calls on it.

## Channel method continuation

Calling a peer method (including `ask_user`'s `feedback_form`) is a durable
receipt, not an in-memory promise. `native-channel-method.ts` records a
`vibestudio.channel-method-admission` document with the immutable request and
the call ids, sends it with `ChannelClient.callMethod`, and settles only when
the matching `agentic` channel event for that invocation is read back from the
canonical channel log (`nativeChannelMethodReceiptKey` is a routing hint, never
result authority). Outcomes are `invocation.completed`, `failed`, `cancelled`
or `abandoned`; cancellation goes through `cancelCall`. There is no
`pending_calls` table or `pendingResolvers` map.

## Workspace layout

Skills and the agent system prompt live under `workspace/` and are
read via the `workspace.*` RPC service:

```
workspace/
├── meta/
│   ├── AGENTS.md        # Workspace system prompt content
│   └── vibestudio.yml     # Init panels and workspace config
├── packages/foo/
│   └── SKILL.md         # Repo-specific skill docs travel with this package
└── skills/              # Cross-repo skills (onboarding, sandbox, workspace-dev, etc.)
    └── ...
```

## Package map

| Package                      | Location                              | Contents                                                                                      |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Workspace agent runtime      | `workspace/packages/harness/`         | Resource loader, system prompt, standard tools, channel boundary types                        |
| Channel client package       | workspace package                     | Panel-side channel client and protocol types                                                  |
| `@workspace/runtime`         | `workspace/packages/runtime/`         | DurableObjectBase, HttpRpcBridge                                                              |
| `@workspace/agentic-do`      | `workspace/packages/agentic-do/`      | AgentVesselBase, AgentWorkerBase, ChannelClient, SubscriptionManager                        |
| `@workspace/agentic-core`    | `workspace/packages/agentic-core/`    | Derived UI types, channel-view to chat projection, ConnectionManager                          |
| `@workspace/agentic-chat`    | `workspace/packages/agentic-chat/`    | useChannelMessages, useChatCore, useAgenticChat                                               |
| Workers                      | `workspace/workers/`                  | e.g. `agent-worker`, `silent-agent-worker`                                                    |

## Further reading

- **Pi-architecture deep dive**: `docs/pi-architecture.md`
- **Pi SDK reference**: `node_modules/@mariozechner/pi-coding-agent/README.md`
- **workspace-dev skill**: `workspace/skills/workspace-dev/WORKERS.md`

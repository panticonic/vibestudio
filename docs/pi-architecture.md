# Pi-Native Vibestudio: Deep Dive

> ⚠️ **Session-persistence detail predates the Unified Log rework.** The
> in-process rationale below still holds, but `pi_sessions`/JSONL-resume detail is historical — persistence is
> migrating to the unified log model (`docs/stage0-unified-log-spec.md`,
> `docs/ws1-agent-loop-spec.md`); the specs win where they disagree.

## Why Pi runs in-process

Before this rearchitecture, Vibestudio used a 4-layer pipeline:

1. Panel (browser)
2. Channel DO (workerd, message routing)
3. Worker DO (workerd, turn lifecycle SQL state)
4. **Harness child process** (Node.js, AI SDK adapter)

The harness layer existed because the workerd runtime couldn't host the
Anthropic SDK. The DO orchestrated turn lifecycle and forwarded events back
and forth via WebSocket-RPC to the harness child.

After Pi research (`@mariozechner/pi-coding-agent`), it became clear that
Pi's `AgentSession` could run inside the worker DO directly:

- Pi has no workerd-incompatible deps in its core path
- Pi's `AgentSession` owns its own state (messages, sessions, branching,
  compaction, retries) — no DO-side state machine needed
- Channel tools and ask_user can be supplied as worker-built tool
  registrations (see `docs/agentic-architecture.md`, "Agent tools on a channel")

The harness child layer became unnecessary substrate. Phase 3 of this
rearchitecture deleted ~9000 lines of harness/transport/adapter/worker-state
code and replaced it with an in-process Pi session (now the pi-durable `Harness`).

## Workspace layout

Skills and the agent system prompt live directly in `workspace/` and are
read via the `workspace.*` RPC service — they are no longer copied into
per-context folders:

```
workspace/
├── meta/
│   ├── AGENTS.md    # System prompt (read via workspace RPC)
│   └── vibestudio.yml # Workspace manifest
├── skills/          # Cross-repo workspace skill packages (read via workspace RPC)
│   ├── sandbox/
│   ├── workspace-dev/
│   └── ...
└── ...              # Other workspace files
```

Workers access these files through the workspace RPC client, not through
a filesystem copy.

## Agent tools (no Pi extensions)

The earlier design wired approval gating, channel-tool routing, and `ask_user`
as Pi extension factories plus a `VibestudioExtensionUIContext`; none of that
exists now. The worker builds `ToolRegistration`s directly
(`workspace/packages/agentic-do/src/agent-worker-base.ts`):

- **Channel method tools** — `native-channel-method-tools.ts` turns each roster
  participant's advertised methods (`workspace/packages/pubsub/src/method-offers.ts`)
  into tools. A method offered once keeps its name; an identical schema offered
  by several participants becomes one tool with a required `target_participant`
  parameter; differing offers or local-name collisions become
  `<method>_<handle>`. Invocation is bound to the original offering
  participant ids.
- **`ask_user`** — `createAskUserTool` / `executeNativeAskUser`
  (`agent-vessel.ts`) send a `feedback_form` to the channel's human
  participants (or the one in `to`) and return the answer.
- **Panel UI tools** — `inline_ui`, `load_action_bar`, `feedback_form`,
  `feedback_custom`, `client_eval`, `inspect_card` are methods advertised by
  the chat panel (`agentic-chat/hooks/useAgenticChat.ts`,
  `hooks/features/useChatFeedback.ts`). Render failures are reported back as
  `ui.feedback` events (`UiFeedbackReporter.tsx`, `agentic-do/src/feedback-ingest.ts`).
  Model guidance: `workspace/skills/visualize`, `workspace/skills/sandbox`.
- **Approval** — permission cards come from the host for sensitive
  operations. `approvalLevel` is a stored per-agent UX setting
  (`agentic-do/src/agent-config.ts`) used by the chat UI; the worker has no
  per-tool-call approval gate.

## Agent session

There is no `PiRunner`. The agent loop runs on `@panticonic/pi-durable`'s
`Harness`, opened per agent Durable Object by `openPlatformAgentSession`
(`workspace/packages/agentic-do/src/native-agent-session.ts`). That function
checks the host-loaded image against the active platform owner, registers an
alarm-source incarnation, and binds the session to its execution owner. The
owner class is `NativeAgentOwner` (`native-agent-owner.ts`); the agent classes
are `AgentVesselBase` (`agent-vessel.ts`) and `AgentWorkerBase`
(`agent-worker-base.ts`). Model transport is in `native-model-*.ts`.

## How fork works

`canFork(channelId)` (`agent-vessel.ts`) only requires a subscription for that
channel. Conversation state moves through the knowledge export/import pair
`exportChannelKnowledge` / `importChannelKnowledge` on `AgentVesselBase`, which
use `native-channel-knowledge.ts`; the original agent settings and domain
configuration travel with it. Subagents are launched through
`native-child-launch.ts`.

## How to add a new skill

1. Decide ownership first. If the skill is specific to one repo, add a top-level
   `SKILL.md` to that repo (`workspace/packages/foo/SKILL.md`,
   `workspace/workers/foo/SKILL.md`, `workspace/extensions/foo/SKILL.md`, etc.) so the
   guidance travels with the code.
2. Use `workspace/skills/<skill-name>/` only for cross-repo workflows or skills
   that are themselves reusable workspace packages with code exports.
   The built-in onboarding skill intentionally stays in
   `workspace/skills/onboarding/` because it describes the whole workspace.
3. Add frontmatter (`name`, `description`) and any additional markdown docs the
   agent can load from the same repo.
4. Ship — the skill is discovered through the workspace repo taxonomy and read
   via the `workspace.*` RPC service; Pi includes the repo path in the generated
   skill index.

## How to debug an agent turn

Agent progress is recorded as durable `agentic.trajectory.v1` channel events
(`@workspace/agentic-protocol`). To inspect a turn, read those events on the
channel; failed turns are summarised by `native-failure-diagnostic.ts`, and
model-call evidence by `native-model-evidence.ts`.

## Where State Lives

Agent session state is owned by the pi-durable `Harness` and persisted in the
agent DO's storage. Vibestudio framework state uses internal Durable Objects:

- `EvalDO` for per-owner sandbox-eval REPL scopes (behind the `eval` service).
- `WorkspaceDO` for panel tree and search (replaced the former `PanelStoreDO`).
- `BrowserDataDO` for imported browser data.
- `WebhookStoreDO` for webhook subscriptions.

Userland persistence should be modeled as a Durable Object with `this.sql`.
There is no host database RPC service.

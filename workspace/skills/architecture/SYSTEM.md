# Topology and Trust

## The two-tier trust model

Vibestudio splits into a small **trusted host** and a large **sandboxed
userland**, with the boundary drawn as narrowly as possible.

**The host** is the Electron shell (or headless server + paired native
clients) plus the workspace server process. It owns, exclusively:

- authentication (tokens, device credentials, pairing) and the permission
  system (grants, approval prompts)
- credential storage and injection on network egress
- protected VCS refs (`main` per repo) and the approval-gated compare-and-swap
  that advances them
- the build system and the content-addressed blob/build stores
- disk projection (materializing workspace state into context folders)
- supervision of workerd, extension processes, and panel webviews

**Userland** is everything under the workspace root — the tree that is *your*
file root as an agent. All of it is agent-writable source, versioned in the
workspace VCS, built on demand, and sandboxed at runtime. The host never
executes workspace code in its own process.

The consequence: an agent (or any userland code) can build arbitrary software,
but cannot exfiltrate credentials, silently advance `main`, escape its
filesystem scope, or reach the network unmediated. Safety comes from the
boundary, not from constraining what agents may write.

## Unit kinds

Trust is attached to **declared package identity**, not filesystem position.
`@workspace-apps/foo` at `apps/foo` is trusted because its unit was approved,
not because it lives under `apps/`.

| Kind | Runs in | Trust | Use for |
|---|---|---|---|
| **Panel** (`panels/*`) | Isolated webview, talks to server over WebSocket RPC | Sandboxed | User-facing UI surfaces |
| **Worker / DO** (`workers/*`) | workerd V8 isolate | Sandboxed | Server-side userland logic; DOs are the app-database primitive (`this.sql`) |
| **Extension** (`extensions/*`) | Forked Node process, full Node access | **Trusted** (elevated install/update approval) | Wrapping native deps, long-lived Node services, replacing in-host services |
| **App** (`apps/*`) | Trusted client runtime: `electron` shell view, `react-native` signed bundle, or `terminal` artifact | **Trusted** client unit | Client software with its own runtime target |
| **Package** (`packages/*`) | Wherever imported | As importer | Shared libraries |
| **Project** (`projects/*`), `meta/` | Content only | n/a | Plain content repos; ungated push |

Panels/workers are sandboxed by construction; extensions and apps cross the
trust line, which is why their install/update/push flows carry richer,
elevated approvals.

## RPC vs userland services

Two deliberate systems, non-overlapping:

- **Platform RPC** (`@vibestudio/rpc`) is fetch-shaped: one caller, one
  target, one value or one streamed Response. Used for host service calls
  (`fs.read`, `credentials.fetch`, `blobstore.*`), credential proxying, model
  fetches.
- **Userland services** are workspace-declared workers/DOs resolved by
  protocol (declared in `meta/vibestudio.yml`, resolved via
  `workers.resolveService`). Conversation-shaped: multiple subscribers,
  replay, participants, structured streaming chunks. Channels are the
  canonical example.

Rule of thumb: point-to-point call/response → RPC; anything with subscribers,
replay, or durable multi-participant state → declare a userland service.

## Transport identity

Every RPC transport carries two identity layers:

- `callerId` — durable application identity (shell, a panel id, a worker id).
  May have zero..many live connections. Safe to persist.
- `connectionId` — ephemeral transport identity for one authenticated socket.
  **Never persisted.**

Event delivery is either pub/sub (`emit` — reaches subscribers only) or direct
(`emitToCaller` — every live session of a durable caller; `emitToConnection` —
exactly one transport instance). Reconnect semantics: `resubscribe` is state
recovery (desired subscription state), `cold-recover` is an edge-triggered
server-restart repair; handlers must be idempotent around reconnect
boundaries.

## The agentic stack

The agent system is a 2-layer userland architecture — it enjoys no special
host privileges:

```
Panel (chat UI)  ⇄  Channel DO (pub/sub log)  ⇄  Agent Worker DO (embeds Pi in-process)
```

- **Channel DO** — a generic userland pub/sub substrate over the unified log:
  durable envelopes, participant roster with unique handles, replay for late
  subscribers. The chat transcript *is* a reduction over persisted channel
  envelopes; there is no separate transcript store.
- **Agent worker DO** — extends `AgentWorkerBase`
  (`packages/agentic-do`), owns one Pi runner per subscribed channel. Pi (the
  coding-agent engine) runs *in-process* in the DO — no harness child
  process. The runner converts Pi lifecycle events into canonical trajectory
  events (`message.*`, `invocation.*`, `turn.*`), appends them to the
  workspace store, and publishes selected events to the channel.
- **System prompt composition** — base prompt + `meta/AGENTS.md` + a generated
  one-line-per-skill index (name, path, description). Full skill docs are
  *pulled* by the agent via `read()`; nothing else is pushed into context.
- **Tools** — the agent's `eval` runs server-side in its own per-agent
  `EvalDO` as an ordinary `do`-principal caller. This is the reachability
  guarantee: anything a DO can call, an agent can reach through eval, with
  the same permission gates and consent prompts. Direct tool allow-lists on
  host services are a UX optimization, not the capability model.
- **Multi-agent** — other agents are just more worker DOs subscribed to the
  same channel; subagents are delegated child agents with their own task
  channel and child context. Channel handle uniqueness lets participants'
  advertised methods become tools without collision.

Because agents, panels, and workers are all just channel participants and RPC
callers, "what can the agent do?" always reduces to "what can this caller
identity do through the permission system?" — see SECURITY.md.

## Contexts

A context is an isolated execution environment: its own materialized **context
folder** (a projection of workspace state) and context id. Panels sharing a
context share a filesystem; the chat agent and the panels it spawns typically
share one. Your context is a **pinned snapshot** — reads do not drift as
`main` advances under you (see STORAGE.md for the VCS semantics).

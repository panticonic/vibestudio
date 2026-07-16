# What is Vibestudio?

> This is the user-level overview. For the system's underlying theory —
> trust boundary, storage model, permission system — read the
> [architecture skill](../architecture/SKILL.md).

Vibestudio is a desktop application (Electron) that gives you a personal, AI-powered workspace organized as horizontally stacked panels. Each panel is its own TypeScript app running in an isolated webview, and an AI agent (the chat panel) can create, edit, and launch new panels on the fly.

## Key Concepts

### Panels

Panels are the building blocks of your workspace. Each panel is a self-contained TypeScript/React app that gets bundled by esbuild and served in its own webview. Panels can:

- Access a sandboxed filesystem, AI models, and DO-backed app databases
- Open browser panels to view and automate websites
- Communicate with other panels via RPC
- Launch child panels

The **chat panel** is the default root panel — it's where you interact with the AI agent.

### Trusted Apps

Trusted workspace apps live under `apps/` and use package names such as
`@workspace-apps/shell`, `@workspace-apps/mobile`, and
`@workspace-apps/remote-cli`. Apps are for trusted client runtimes, not ordinary
panels. Use the `appdev` skill before creating or changing apps.

### Workspaces

A workspace is a named collection of panels, packages, workers, and configuration. You can:

- Create multiple workspaces (e.g. "personal", "work", "experiment")
- Fork a workspace to branch off a snapshot
- Switch between workspaces (triggers app relaunch)
- Configure which panels open on first launch (`initPanels`)

Workspace config lives in `meta/vibestudio.yml`. Each workspace gets one
semantic provenance/VCS graph with a committed event and exact working head.

### Contexts

A context is an isolated execution environment for a panel. Each context gets:

- Its own **context folder** — a materialized view of the workspace state
- A unique **context ID** used in URLs and storage

Panels in the same context share a filesystem. The chat panel's agent and its child panels typically share a context so they can see each other's files.

### The Agent (Chat Panel)

The chat panel hosts an AI agent that can:

- **Run code** via the `eval` tool — runs server-side in the agent's own persistent sandbox (works even if the panel is closed)
- **Render UI** via `inline_ui` (persistent components in chat), `load_action_bar` / panel `actionBarFile` (compact pinned panel controls), and `feedback_custom` (interactive forms)
- **Preserve transcript state** through typed PubSub events: messages,
  invocations, inline UI, and action bars all replay from the same channel log
- **Read/write files** in the workspace
- **Build and launch panels** on demand
- **Connect API provider integrations** — Gmail, GitHub, Slack, and other OAuth/credential-backed services
- **Tune its own model defaults** — the host chat agent's provider, effort, approval, and chattiness are configurable
- **Import browser data** — cookies, passwords, bookmarks, history
- **Automate browsers** via Playwright-style CDP automation (`handle.cdp.lightweightPage()`)
- **Use private eval SQLite for scratch work**, call DO-backed app databases,
  call AI models, manage workers

### Workers (Workerd)

Workers are Cloudflare V8 isolates (via workerd) that run server-side logic. They support **Durable Objects** for persistent, stateful services. The agent system itself runs on workers with DOs for conversation channels and agent state.

Durable Objects are the normal application database primitive: each DO instance
owns SQLite through `this.sql`, and panels/apps/agents call its declared service
methods through `workers.resolveService(...)` and `rpc.call(...)`. The eval
`db` is private scratch storage for the agent's EvalDO, not a shared app
database.

### Runtime APIs

All panels and sandbox code can import from `@workspace/runtime`:

| API         | What it provides                                     |
| ----------- | ---------------------------------------------------- |
| `fs`        | Filesystem scoped to the context folder              |
| `ai`        | Text generation and streaming (multiple model roles) |
| `workers`   | Resolve worker/DO services, including app databases  |
| `workspace` | List, create, configure, switch workspaces           |
| `rpc`       | Call services on the main process or other panels    |

Additional surfaces: `browserData` from `@workspace/runtime` (browser data import/export), and `@workspace/cdp-client` (the lightweight, workerd-native CDP client used by `handle.cdp.lightweightPage()` — the single Playwright-style browser-automation surface; reach it through the handle, and use its exported `CdpConnection` only for protocol-level work).

### Build System

Panels and workers are built **on demand** — when you navigate to a panel URL or
create a worker instance, the build system compiles an explicit semantic or
content build source with esbuild. A protected publication can notify build
subscribers, which recompute affected effective versions as derived
projections. Publication itself does not run or certify those builds.

## Architecture at a Glance

```
┌─────────────────────────────────────────────────┐
│  Electron Host                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Chat     │ │ Panel A  │ │ Browser  │  ...    │
│  │ (agent)  │ │          │ │ Panel    │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │ WebSocket   │            │              │
│  ┌────┴─────────────┴────────────┴──────┐       │
│  │  Server (RPC, build, VCS, services)  │       │
│  └────┬─────────────────────────────────┘       │
│       │                                         │
│  ┌────┴──────────────────┐                      │
│  │  Workerd (workers/DOs)│                      │
│  └───────────────────────┘                      │
│       │                                         │
│  ┌────┴──────────────────┐                      │
│  │  Semantic VCS graph    │                      │
│  └───────────────────────┘                      │
└─────────────────────────────────────────────────┘
```

- **Panels** connect to the server over WebSocket for RPC
- The **server** handles builds, file access, VCS, external Git interop, database, AI proxy, and service routing
- **Workerd** runs workers and Durable Objects in V8 isolates
- The **semantic VCS graph** unifies source intent, applications, decisions,
  ancestry, provenance, and exact content projections

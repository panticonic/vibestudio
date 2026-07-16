---
name: architecture
description: Explain Vibestudio's host/workspace trust boundary, unit kinds, agentic topology, log and semantic-graph storage, causal provenance, permission/credential/approval systems, semantic publication, and derived builds. Use when designing or reviewing cross-cutting architecture, deciding which component owns state or effects, or checking whether a proposed cache, service, or history representation duplicates authority.
---

# Vibestudio System Architecture

This skill is the agent-facing distillation of the system's fundamental
architecture. Load it when you need to reason about _how the system works as a
whole_ — trust boundaries, where state lives, who has authority over what —
rather than how to perform a specific task. Task-level skills (workspace-dev,
sandbox, extensiondev, appdev, gad-context, api-integrations) tell you _how_;
this skill tells you _why the system is shaped this way_ and which component
owns which decision.

## The system in one paragraph

Vibestudio is a personal computing environment where AI agents build and run
software safely. A trusted **host** process (Electron shell + workspace server)
owns everything security-critical: credentials, permissions, protected VCS
refs, builds, and egress. All user-visible and agent-written code runs in
**sandboxed userland**: panels in isolated webviews, workers and Durable
Objects in workerd V8 isolates, extensions in supervised Node processes, apps
as approved trusted clients. Every durable fact — conversation turns, file
edits, channel messages, VCS history — is an event appended to a hash-chained
**trajectory/channel log** or immutable node in the semantic workspace graph;
everything else (materialized files, search indexes, build outputs) is a
projection that can be rebuilt from those facts and content-addressed values. Agents
are ordinary userland participants: they act through the same RPC services,
the same permission gates, and the same VCS publication boundary as any other
code.

```
┌────────────────────────────────────────────────────────────────┐
│ Trusted host                                                   │
│  Electron shell / native clients / CLI  ── paired devices      │
│  Workspace server: RPC, permissions, credentials, refs,        │
│  builds, blobstore, disk projection, egress                    │
├────────────────────────────────────────────────────────────────┤
│ Sandboxed userland (the workspace — YOUR file root)            │
│  Panels (webviews) · Workers/DOs (workerd) · Extensions (Node, │
│  trusted) · Apps (approved clients) · Agents (in-process Pi    │
│  inside worker DOs)                                            │
├────────────────────────────────────────────────────────────────┤
│ State: trajectory/channel logs + semantic VCS graph/event DAG │
│ + content-addressed values + protected refs + caches           │
└────────────────────────────────────────────────────────────────┘
```

## Files

| Document                   | Content                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [SYSTEM.md](SYSTEM.md)     | Topology and trust: host vs userland, unit kinds, RPC vs workspace services, transport identity, agentic stack |
| [STORAGE.md](STORAGE.md)   | Theory of state: log/value/ref/cache, GAD ledgers, semantic workspace state, causal calls, blobstore, builds   |
| [SECURITY.md](SECURITY.md) | Permissions, approvals, credentials, device/principal identity, why agents are safe by construction            |

## The seven load-bearing ideas

1. **Narrow host boundary.** The host does only what _must_ be trusted:
   identity, permission decisions, credential injection, protected `main`
   refs, builds, disk projection, network egress. The semantic control plane is
   a product-sealed internal DO bundle behind that boundary, not a manifest
   unit. Everything else — including the agent runtime itself — is userland and
   can be rebuilt, forked, or replaced without touching the trusted core.
2. **Trust is declared, not positional.** A workspace unit is trusted because its
   declared package identity was approved through an elevated flow, not
   because of where it sits on disk. Unit kinds: panels (UI surfaces),
   workers/DOs (server-side userland), extensions (trusted Node services),
   apps (trusted clients with electron / react-native / terminal targets).
   Internal product bundle source may share package layout for ergonomics but
   does not become a workspace unit or acquire runtime identity from its path.
3. **Durable history is immutable and walkable.** Trajectory/channel delivery
   uses hash-chained logs. Semantic source history uses commands, work units,
   changes, basis-specific applications, integration decisions, content edges,
   and a workspace-event DAG. Both expose immediate typed edges; caches are
   amnesiac and rebuild from durable facts.
4. **One trajectory, joined to semantic work.** Messages, turns, and tool
   invocations live in the canonical trajectory log. Semantic commands, work
   units, changes, applications, and events live in the workspace graph. One
   exact invocation-to-command edge joins them; there is no sidecar provenance
   ledger or claims database. Approval remains authorization owned by its
   permission gate, not a competing history.
5. **One semantic authority, narrow effect adapters.** The content store owns
   immutable bytes/trees, the semantic control plane owns semantic graph facts
   plus context committed-event and working-head pointers, and the publication
   gate owns approval plus atomic protected-ref updates. File projection, Git
   interop, and builds consume semantic state; none forms a parallel history.
   Protected `main` advances only when the committed event has valid ancestry
   and integration facts and publication is approved. Builds are explicit
   advisory checks or post-publication projections, never publication
   authority. Runtime activation rejects a bad projection and retains the
   previous runnable artifact.
6. **Tokens authenticate; grants authorize.** A runtime token only says who
   is calling. Every sensitive action passes a server-side permission gate
   with scoped grants (once / session / version). Credentials are URL-bound
   and injected by the host only on egress to approved audiences — userland
   code, including you, never sees secret material.
7. **Agents are ordinary participants.** An agent is Pi running in-process
   inside a worker DO, subscribed to a channel. It reaches the system through
   the same services, sandbox (eval in its own EvalDO), and gates as any
   panel or worker. Nothing about being an agent grants extra authority.

## Authority ordering when docs disagree

Trust (1) the live generated service schema and schema of record, (2) the
canonical domain skill, then (3) broader orientation prose. For semantic VCS,
`skills/vibestudio-vcs` is the canonical operating protocol. Only its
event/application state-node, workspace-event, semantic-work-unit model is
valid; broader orientation prose cannot define an alternate VCS procedure.

Deeper reference docs (specs, design history) live in the Vibestudio _source
checkout_ under `docs/` — outside your workspace file root. If you need them,
ask the user or a host-side session; do not guess at their content.

---
name: architecture
description: The theory of the whole Vibestudio system — host/workspace trust boundary, unit kinds, agentic topology, log-first storage and VCS authority model, permission/credential/approval systems, build gate. Load this to reason about how the system fits together before designing anything cross-cutting.
---

# Vibestudio System Architecture

This skill is the agent-facing distillation of the system's fundamental
architecture. Load it when you need to reason about *how the system works as a
whole* — trust boundaries, where state lives, who has authority over what —
rather than how to perform a specific task. Task-level skills (workspace-dev,
sandbox, extensiondev, appdev, gad-context, api-integrations) tell you *how*;
this skill tells you *why the system is shaped this way* and which component
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
**log**; everything else (SQL tables, materialized files, build outputs) is a
projection that can be rebuilt from logs and content-addressed values. Agents
are ordinary userland participants: they act through the same RPC services,
the same permission gates, and the same VCS push gate as any other code.

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
│ State: unified logs (trajectory/channel/vcs) + content-        │
│ addressed values (blobstore) + protected refs + caches         │
└────────────────────────────────────────────────────────────────┘
```

## Files

| Document                     | Content                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [SYSTEM.md](SYSTEM.md)       | Topology and trust: host vs userland, unit kinds, RPC vs userland services, transport identity, agentic stack |
| [STORAGE.md](STORAGE.md)     | Theory of state: log/value/ref/cache, GAD ledgers, VCS authority model, blobstore, build system                |
| [SECURITY.md](SECURITY.md)   | Permissions, approvals, credentials, device/principal identity, why agents are safe by construction           |

## The seven load-bearing ideas

1. **Narrow host boundary.** The host does only what *must* be trusted:
   identity, permission decisions, credential injection, protected `main`
   refs, builds, disk projection, network egress. Everything else — including
   the agent runtime itself — is userland and can be rebuilt, forked, or
   replaced without touching the trusted core.
2. **Trust is declared, not positional.** A unit is trusted because its
   declared package identity was approved through an elevated flow, not
   because of where it sits on disk. Unit kinds: panels (UI surfaces),
   workers/DOs (server-side userland), extensions (trusted Node services),
   apps (trusted clients with electron / react-native / terminal targets).
3. **Everything durable is a log.** One envelope shape, one
   append/fork/replay/integrity code path for trajectory, channel, and VCS
   logs (`log_kind` is metadata, never a structural switch). Journal before
   dispatch; folds are pure; caches are amnesiac — any derived state may be
   deleted and rebuilt.
4. **Two ledgers per agent.** The model-visible trajectory (what can be
   re-materialized into prompt context) is separate from sidecar provenance
   (tool dispatches, file observations, approvals, claims). Provenance is
   never silently injected into context.
5. **Authority is split three ways for source.** The server's content store
   owns immutable trees; the server's RefService owns protected `main` refs
   (advanced only by compare-and-swap through the approval gate); the gad DO
   owns provenance, merge, and edit/commit semantics. Your edit→commit→push
   workflow is the userland face of this split — push is the *only* way
   `main` advances, and it is build-gated and approval-gated by the host.
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

The system is mid-migration to the Unified Log Architecture. When guidance
conflicts, trust in this order: (1) the actual schema of record
(`workers/gad-store/index.ts`) and live service behavior; (2) this skill;
(3) task skills. Storage tables are `log_heads` / `log_events` / `refs` /
`ref_log` plus `trajectory_*` and `gad_*` projections — older prose
mentioning `pi_branches` / `pi_entries` / `pi_sessions` describes the same
model under superseded names.

Deeper reference docs (specs, design history) live in the Vibestudio *source
checkout* under `docs/` — outside your workspace file root. If you need them,
ask the user or a host-side session; do not guess at their content.

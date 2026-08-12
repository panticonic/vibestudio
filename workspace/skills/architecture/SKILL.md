---
name: architecture
description: Design or review cross-cutting Vibestudio architecture: trust boundaries, unit ownership, agent topology, durable logs and semantic state, provenance, permissions, credentials, publication, builds, and caches.
---

# Vibestudio architecture

Use this skill to decide which component owns a fact or effect. Use task skills
for implementation details.

## Read by question

| Question | Reference |
| --- | --- |
| Host/userland boundary, unit kinds, RPC, transport, agents | [SYSTEM.md](SYSTEM.md) |
| Durable state, logs, semantic VCS, provenance, blobs, builds | [STORAGE.md](STORAGE.md) |
| Permissions, approvals, credentials, devices, principals | [SECURITY.md](SECURITY.md) |

## System model

The trusted host owns identity, protected refs, permission decisions,
credential injection, builds, disk projection, and network egress. Workspace
units have explicit trust models: panels run in isolated webviews; workers and
Durable Objects run in workerd isolates; extensions run as approved Node
services; apps are approved clients. Agents are ordinary workspace
participants and use the same services and gates as other callers.

Durable conversations and tool activity live in canonical trajectory/channel
logs. Managed source, applications, integration decisions, and publication
live in the semantic workspace graph. Materialized files, indexes, Git
checkouts, and build outputs are projections; do not make one a competing
authority.

## Load-bearing invariants

- Keep the trusted host narrow. Workspace behavior belongs in workspace units
  unless it must enforce a trust boundary.
- Trust comes from declared identity and review, not filesystem location.
- Store durable history as immutable, walkable facts. Caches must be disposable
  and rebuildable.
- Join tool invocations to semantic work through recorded causal edges; do not
  add a claims or provenance sidecar.
- Keep semantic source authority singular. Git, builds, and filesystem
  projections are adapters or consumers.
- Authentication establishes caller identity; grants and approvals authorize
  effects. Credentials stay host-held and audience-bound.
- Protected publication validates ancestry, integration, the exact candidate,
  and approval. Runtime activation fails closed and retains the runnable
  artifact when a derived build is bad.

When documents disagree, prefer the live generated service contract and schema
of record, then the canonical domain skill, then broad orientation prose. For
managed source operations, [Vibestudio VCS](../vibestudio-vcs/SKILL.md) is the
canonical workflow.

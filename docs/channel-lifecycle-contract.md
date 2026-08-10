# Channel lifecycle contract

Status: current product contract\
Decision date: 2026-07-27

This document records the outcome-A channel audit requested by
`runtime-foundations-self-development-salvage-report.md`: the current product
behavior is intentional. The runtime-foundation ledger must describe this
behavior and must not imply a structure-revision system that does not exist.

## Ordinary channels

An ordinary channel is workspace-scoped and mutually trusted.

- A workspace member who can address a channel may join it. Durable
  `channel_members` rows are invite, discovery, and offline-roster metadata;
  they are not an admission ACL.
- Inviting a member never fabricates presence. Presence begins only when that
  member actually subscribes.
- The invite index is keyed by the host-verified user identity. It is a
  discoverability projection, not a second owner of membership or admission.
- First subscription may initialize an ordinary channel's context and initial
  config. Subscription therefore does not promise a read-only
  "structure-never-created" operation.
- Human participant identity is derived from the authenticated account.
  Caller-supplied `user:*` identities are rejected.

These choices preserve the existing multi-human UX: invitations make channels
easy to find without turning an invitation delivery record into a security
boundary.

## Locked channels

Locked channels are the explicit admission boundary.

- Only the host may initialize a locked channel.
- Initialization atomically binds the context, exact canonical config, and
  participant set.
- Repeating the identical initialization is idempotent. Any different payload
  is identity drift and fails.
- Locked membership is immutable for that channel. Neither subscription nor
  `updateConfig` may create or widen it.
- Subscription still proves the caller-derived participant identity. Durable
  Object participants must also be active; agent vessels must present their
  current incarnation.

There is no ownership-transfer or structure-revision operation. A different
locked membership means a different channel.

## Mutable config

The current config is one value, not a structure/presentation split.

- `membershipPolicy` is immutable admission state.
- Title, explicit-title state, approval level, conversation policy, agent-hop
  limit, and named policies are mutable by the existing host/code-authorized
  `updateConfig` operation.
- Config changes append a durable `config-update` event and invalidate policy
  selection before being broadcast.

Introducing separate structure and presentation revisions would be a product
change, not a correctness repair. It requires a new reviewed decision rather
than being inferred from the historical ledger.

## Ownership, deletion, and forks

- Ordinary channels do not currently have a durable owner, so ownership
  transfer and owner disappearance have no lifecycle semantics.
- The channel does not expose a durable deletion tombstone contract.
- Fork provenance and its crash-recovery journal are current behavior, but
  they do not imply a general channel-structure revision model.

The runtime-foundation ledger must omit ownership-transfer, tombstone, and
general immutable-structure claims until those behaviors exist and have direct
evidence.

## Durable delivery guarantee

Entity mailbox delivery is at-least-once. A mailbox item is acknowledged only
after the recipient accepts and processes it, but an activation can still fail
after guest code performs a side effect and before the channel observes the
settlement. Resident event handlers must therefore be idempotent. Method
providers receive a generation-fenced single-claimant lane: direct fast-path
and mailbox delivery collapse to one active execution, stale generations
cannot publish results, and cancellation is delivered out of band through the
handler's `AbortSignal`. Recovery after provider death may still re-execute an
arbitrary external side effect; providers that need a stronger guarantee must
commit their own idempotency evidence with that side effect.

Resident relationships have three lifecycle states. Attached relationships
materialize mailbox rows; detached relationships retain membership and a log
sequence boundary without growing per-event mailbox debt; ended relationships
carry no future obligation. Re-registration reattaches and backfills the
durable log range. A typed unavailable-receiver refusal and graceful EvalDO
drain both detach, while explicit close or owner retirement ends membership.

Delivery failures are classified at the consumer boundary. Transport,
availability, and infrastructure failures remain retryable without an attempt
deadline. Inputs that cannot become valid on redelivery are terminal poison:
missing provenance, missing referenced blobs, malformed resident envelopes,
and malformed durable wake payloads. The channel records those mailbox debts
as `terminal-integrity`; vessels record malformed wakes as `terminal-poison`.
The classification is a durable lifecycle fact, not a retry-budget timeout.

Local workspace mutation tools use the semantic VCS command journal as their
commit-time replay evidence. The command id is derived from the exact
trajectory invocation, and the journal entry commits atomically with the
mutation. On effect adoption, a completed command synthesizes a successful
replay outcome instead of executing the mutation again. An absent command is
not evidence; an unavailable command journal is an infrastructure failure and
must not authorize execution. Non-workspace external tools remain subject to
their provider's documented at-least-once/idempotency contract.

## Executable evidence

The canonical implementation is
`workspace/workers/pubsub-channel/channel-do.ts`.

Focused evidence belongs to the channel worker's normal test project:

- locked initialization and exact admission:
  `workspace/workers/pubsub-channel/channel-do.test.ts`;
- durable membership, invite discovery, absence of fabricated presence, and
  retry ordering: the same test module;
- fork journaling and lineage: the same test module and
  `workspace/workers/pubsub-channel/fork-journal.ts`.

Generated ledgers may cite stable test evidence registered by the
runtime-foundation evidence mechanism. They must not cite deleted GAD-store
tests or the historical `ChannelStructureRevision` type.

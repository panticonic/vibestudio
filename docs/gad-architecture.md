# GAD architecture

GAD is Vibestudio's durable semantic graph. It connects agent trajectories,
workspace history, content lineage, and publications through exact immediate
edges. It is not a second filesystem, a service-call ledger, a claims database,
or an authorship database.

The governing rule is simple:

> Store each fact once, at the layer that owns it, and derive every larger story
> by walking outward.

The detailed workspace design and recovery sequence live in
[`provenance-aware-diff-merge-plan.md`](provenance-aware-diff-merge-plan.md).
This document describes how that workspace graph fits into GAD as a whole.

## One graph, several owners

GAD joins facts owned by existing systems:

- the agentic log owns turns, messages, tool invocations, and exact causal
  coordinates;
- the semantic workspace state machine owns commands, contexts, work units,
  changes, applications, events, decisions, and content lineage;
- the approval and protected-ref owners record authorization and publication
  effects;
- the blob/content layer owns bytes and derived materialization trees.

An edge crosses an ownership boundary by naming the other owner's stable
identity. GAD does not copy the other owner's payload into a parallel record.

For an agent-authored workspace change, the ordinary causal walk is:

```text
trigger message
  -> turn
  -> trajectory invocation
  -> semantic command
  -> work unit
  -> change
  -> work application / applied change
  -> workspace event
  -> publication effect and approval receipt
```

An agent-bound request presents its exact invocation coordinate, and the host
verifies that it belongs to the caller's bound trajectory before semantic
ingress. The trusted agent vessel is responsible for presenting the invocation
that actually spawned its call. Actor, turn, initiating user, and downstream
blame are projections of the chain. Authorized direct commands have no agent
edge and stop honestly at the command.

## Semantic workspace state

Workspace state has exactly two addressable node kinds:

```ts
type StateNodeRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };
```

An event is a committed workspace state. An application is one local,
uncommitted transition. A context stores a committed event and a working head;
when clean, both name that event. Each mutation applies one work unit to the
prior head and advances the head with compare-and-swap.

The immutable state root is a persistent workspace-fact map. It resolves stable
repository and file identities, repository paths, manifests, placements,
content hashes, and tombstones. Host tree hashes are derived projections for
materialization and builds. They are not semantic revisions and cannot be used
as ancestry or provenance.

## Work, changes, and applications

A `WorkUnit` records one accepted intent. It reaches its cause through the
originating command and groups the changes and decisions produced by that
intent.

A `Change` is the stable semantic contribution and the thing integration or
revert accounts for. Its kind is expressive: text or binary edit, file
create/delete/restore/move/copy/mode, or repository lifecycle. An import work
unit carries its external snapshot tuple and authors these same ordinary
changes; import is not a change kind.
Coordinated mechanical effects stay one change—for example, a cross-repository
move removes one route, adds another, and updates one stable file placement.

A `WorkApplication` records how a work unit applied to one exact prior state.
Its applied changes and result predicates explain what became true on that
basis. Reapplying existing source work during integration preserves the
original change identity and causal origin; the integration work unit records
incorporation rather than claiming new authorship.

There is no separate contribution or result layer. Those views are reached
through change, application, and applied-change edges.

## Local integration

`vcs.compare` observes an exact target state against one committed source event
and classifies source changes as shared, already satisfied, actionable,
accounted, or historical. It creates no session or durable plan.

`vcs.integrate` records one local adopted, reconciled, or declined decision at a
time:

- adopted applies the original source change and records exact incorporation
  mappings;
- reconciled binds the source change to truthful target-state evidence and a
  rationale;
- declined records the deliberate refusal and rationale without changing
  bytes.

Each decision is an ordinary work unit/application on the context. Agents can
test between steps. `vcs.commit` commits the complete local application chain.
An integration commit names the source event as its second parent only after
every effective source change is accounted for. `vcs.push` then publishes the
already committed event. Nothing before push changes protected `main`.

The event, its parents, decisions, applications, and changes are the complete
integration evidence. No plan token, staging set, frozen source wrapper, or
extra proof object is stored.

## Content lineage and blame

Content provenance records immediate coordinate mappings:

- `preserves` maps unchanged content through an edit;
- `authored-copy-source` connects a copy change to its exact source state and
  file;
- `copies-content` maps source coordinates into the new file when that change
  is applied;
- `incorporates` maps adopted source content into the target application.

Move preserves file identity. Copy creates a new identity, records its exact
authored source, and maps the content preserved by that application.
Copy ancestry therefore emerges by walking these immediate facts instead of
storing transitive contribution snapshots.

Blame begins from an exact state, file identity, and range. It walks content
edges to the applied change, work unit, command, and causal invocation when one
exists. When a terminal ordinary change belongs to an import work unit, blame
reports an import boundary. Inspecting that work unit exposes the source-
observed URI/revision and the semantic workspace's exact commitment to the
descriptors it verified. Pre-import coordinate authorship remains unknown.
There is no per-path external evidence graph or standalone claim layer beyond
that boundary.

## Authorization versus provenance

Provenance explains what caused a fact. Authorization decides whether a caller
may create or read it. They are deliberately separate.

The host authenticates the immediate caller and verifies an optional trajectory
coordinate for agent-bound requests. The semantic workspace checks workspace
and context access at ingress. Approval records and publication receipts remain
owned by their existing systems and are linked when relevant. Possessing a node
ID or being upstream in a causal chain does not grant authorization.

## Query surface

Normal clients use small typed roots and four general walks:

- `inspect` returns one node;
- `neighbors` pages immediate typed edges;
- `history` walks focused event/application/change history;
- `blame` walks exact content coordinates.

`status`, `compare`, `readFile`, and `listFiles` are task-shaped projections over
the same graph. Responses return roots that can be handed directly to the walk
methods. Paging uses deterministic order and an opaque cursor; a growing
trajectory is restarted from its root. The server stores no traversal queue,
visited set, observation proof, or stateful cursor.

## Host effects and durability

The semantic workspace Durable Object writes semantic facts and a generic
outbox effect atomically, then returns. The server executes narrow owner-local
materialization, build, or publication ports and acknowledges an exact receipt.
Retry resumes the same effect. The semantic workspace never calls back into the
host, and the host never interprets changes or integration decisions.

Garbage collection asks the semantic owner for the content roots and file
digests retained by its event/application graph and pending effects, unions
those with protected-main roots, walks the actual Merkle trees, and sweeps only
workspace-CAS entries older than the safety window. The managed hourly
`VcsGcScheduler` starts after semantic activation. Protected publication
evidence is separately acknowledgement-compacted: acknowledged history is
discarded once it is no longer the protected head, while unacknowledged effect
or observer evidence remains replayable.

## Architectural test

A new entity or service belongs in this architecture only when it owns a fact
that cannot be reached from an existing owner. If it merely authenticates,
summarizes, transports, caches, or relabels facts already in the graph, keep it
derived—or delete it.

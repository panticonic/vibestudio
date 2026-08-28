# Minimal provenance-native workspace version control

Status: DESTRUCTIVE PRE-RELEASE RECOVERY SPECIFICATION (2026-07-16)

This document replaces the earlier provenance-aware diff/merge plan. The old
plan accumulated parallel state identities, capability wrappers, proof packets,
query accelerators, and product services. Those structures are not retained for
compatibility. This specification deliberately gives up requirements when they
would make the semantic graph harder to understand or create a second source of
truth.

The product goal is small:

1. edits are expressive records, including moves, copies, deletes, modes, and
   repository lifecycle;
2. every durable mutation has one walkable causal spine from the triggering
   message through its turn and tool invocation to a globally unique semantic
   command, work unit, and changes;
3. a context accumulates ordinary local changes and integration decisions in
   small steps;
4. commit records those local steps; an integration commit additionally names
   the source event it has fully accounted for;
5. push publishes an already committed event through one approval-gated atomic
   protected-ref update;
6. there is one semantic state graph and one derived content projection;
7. builds are explicit advisory checks or post-publication projections, never
   publication authority, and runtime activation keeps the previous runnable
   artifact when a new projection fails.

There is no compatibility reader, legacy schema, migration, parallel merge
engine, mutable merge session, merge-state marker, pending merge tree, authorship
credential, VCS authority service, source-basis capability, merge certificate,
stateful provenance cursor, or second ancestry index.

---

## 1. Design law: store each fact once

Every proposed table, field, root, receipt, or service must answer one question:

> What new fact does this own that cannot be reached from an existing fact?

If the answer is “it summarizes, authenticates, authorizes, accelerates, or
relabels existing facts,” it is a derived view or cache. It does not enter
semantic identity and is not required for correctness.

This rule has concrete consequences:

- an event is a committed state; there is no committed-frontier wrapper;
- an application result is a local working state; there is no working-frontier
  wrapper or application-sequence graph;
- a decision points directly to its exact source state; there is no source-basis
  object;
- an integration event and its decisions are the integration proof; there is no
  merge certificate;
- event parents are ancestry; there is no authenticated ancestor set;
- an agent-caused command points to its causal ingress coordinate; direct
  commands stop at themselves, and actor, invocation, and turn are never copied
  columns;
- agent intent is reached by walking trigger message → turn → invocation →
  command → work unit → change → applied change; there is no author or intent
  payload to keep synchronized;
- a copy points to its immediate source coordinate; transitive blame is walked,
  not snapshotted;
- a workspace semantic root commits semantic facts; host tree hashes are derived
  materialization receipts, not revision identities;
- exact indexed queries establish observation completeness; a hash of a query
  packet does not.
- an import work unit stores its exact external snapshot tuple once and authors
  ordinary repository and file changes; it does not grow a synthetic barrier
  change, parallel external-history graph, or imported authorship graph;
- `vcs.readFile` reads semantic state only; host filesystem observation belongs
  to `fs`, not to a raw mode hidden inside VCS.
- durable intent lives on the ordinary message/turn/invocation/command/work-unit
  spine and in the work unit's optional intent summary; there is no standalone
  claim ledger, claim relation graph, claim event family, or claim-specific
  recall index.

Content-addressed identities include their canonical payload digest. A separate
`canonical_digest` column is forbidden unless the row contains independently
mutable non-identity data, which semantic rows should generally not contain.

---

## 2. One walkable graph

### 2.1 Immediate edges, derived meanings

The graph records immediate causal and semantic edges. User-facing concepts are
projections:

```text
trigger message
  -> turn
  -> tool invocation
  -> semantic command
  -> work unit
  -> change
  -> application / applied change
  -> workspace event
  -> publication effect and approval receipt
```

Content lineage is another immediate-edge graph:

```text
current file coordinate
  -> application file transition
  -> prior file coordinate
  -> ...
  -> applied change that authored the coordinate
  -> work unit -> command -> causal ingress, when agent-caused
```

The following are distinct questions and must never be flattened into an
“author” bundle:

- `executedBy`: the authenticated runtime observed at ingress; this is not
  promised as durable history by the semantic graph;
- `causedBy`: exact tool invocation, request, or runtime effect upstream;
- `initiatedBy`: the observable intent root reached through recorded causality—
  a triggering message for agent-caused work or the command itself for a direct
  operation;
- `authorizedBy`: the owning subsystem's ingress decision, historically
  discoverable only when that subsystem already persists a receipt;
- `incorporatesFrom`: source change reached through an adoption edge;
- `blame`: terminal authored coordinates reached through content mappings;
- “authorship”: a requested projection that must specify which of the above it
  means.

Causality grants no authorization. Authorization is checked at ingress using
the existing runtime, context ownership, and approval systems. The semantic
graph does not invent a durable authorization edge merely to preserve that
decision; an owning permission or publication system may expose its own real
receipt where one exists.

### 2.2 Causal ingress

Every agent-caused semantic mutation must name one exact durable trajectory
invocation. The agentic log already owns the message, turn, and invocation
facts:

```text
trigger message --triggers--> turn --contains--> tool invocation
                                             \
                                              -> semantic command
```

The turn points to its triggering message. The invocation points to its turn.
The semantic command therefore stores only the exact invocation coordinate,
not redundant message, turn, prompt, actor, or user columns:

```ts
interface CausalCommandRef {
  invocation: {
    logId: string;
    head: string;
    invocationId: string;
  } | null; // null for an authorized direct command
}

interface SemanticCommand {
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string; // globally unique across the workspace semantic store
  method: string;
  requestDigest: string;
  cause: CausalCommandRef;
  status: "pending" | "effect-pending" | "complete";
  result: unknown;
}
```

The transport authenticates the immediate caller and verifies that a presented
invocation belongs to the caller's bound trajectory/head. The trusted agent
vessel remains responsible for presenting the invocation that actually spawned
the call. Context authorization is checked separately before semantic dispatch;
none of those facts are copied into the command. AgentDO supplies its current
tool invocation as RPC causal context, not as an authorship assertion or public
request field. EvalDO and subagent execution retain their real spawning and
triggering edges in the same agentic log.

An agent judgement becomes durable when it motivates a real semantic command,
decision, or committed event. Its human-readable reason belongs on that fact.
A free-standing `record_claim` operation would create a second, caller-asserted
semantic graph whose causality can disagree with the trajectory; it is therefore
not part of the system. Search and recall may index canonical messages, files,
and event summaries, but those rows are disposable projections rather than a
second source of truth.

The semantic command ID is the mutation's global idempotency key. It is unique
across contexts and methods, not merely within one service call or context. The
ordinary agent tools derive a stable command ID from the globally unique tool
invocation and reuse it only for an identical uncertain retry. The command and
invocation remain distinct nodes because one records semantic admission and
the other records agent execution.

One invocation may cause several separately journaled semantic commands, as an
Eval run or composite tool sometimes must. Each command remains an ordinary
visible node with its own globally unique idempotency identity, request digest,
work unit, and shared exact cause. Do not hide commands behind unwalkable child
ordinals.

An agent-bound caller may mutate only with its exact causal invocation. This
prevents an agent runtime, EvalDO, or extension relay from dropping the intent
edge while retaining its context authorization. A direct human/UI, lifecycle, or
host operation may instead terminate causality honestly at its semantic
command; it must not be relabeled as agent intent. Authorization decides
whether that direct operation is allowed. The absence of agent causality is a
visible end of the walk, not a reason to invent a trajectory.

Do not fill a missing agent edge with a synthetic invocation, hidden adapter
agent, ambient “current invocation,” correlation ID presented as provenance, or
a second command ledger. Agent-path tests create a real trajectory
message/turn/invocation fixture. Internal recovery replays the already-journaled
semantic command; it does not originate a new mutation.

There is no open/close operation, lease, bearer UUID, durable authorship or
capability registry, `agentAuthorship`, “current invocation” lookup, or
universal duplicated service call log. An ephemeral extension-host map may
correlate a host-issued `requestId` while that call is active; it is lifecycle
state, carries no semantic fact or credential, and disappears when the call
ends. Existing transport and trajectory IDs are reused.

Provenance reads use the workspace's existing mutual-trust boundary, the same
boundary as channel replay and trajectory diagnostics. A trajectory-message
inspection projects its exact stored text blocks from the canonical log; it
does not copy them into VCS storage. If per-context prompt confidentiality ever
becomes a product requirement, it must be one resource-read policy applied to
channel replay, trajectory diagnostics, and semantic VCS together—not a
VCS-specific token or capability. Mutations remain context-authorized, and
agent-bound mutations remain causally bound, regardless of this read policy.

“Agent intent” here means durable, observable evidence: the exact message that
opened the turn, the turn's optional summary, the selected tool invocation and
lifecycle, the admitted semantic command, the work unit's optional concise
summary, and the resulting semantic changes. The system does not persist or
infer private model reasoning as provenance. Exact bulky tool arguments remain
owned by the canonical trajectory event referenced by the invocation; bounded
VCS inspection does not copy them or turn them into a second intent record.

### 2.3 Exact state nodes

There are exactly two kinds of semantic state node:

```ts
type StateNodeRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };
```

- A `WorkspaceEvent` is a committed state.
- A `WorkApplication` is a local uncommitted state transition and owns its exact
  result workspace fact root.

No `StoredWorkspaceFrontier` exists. A context stores:

```ts
interface ContextHead {
  contextId: string;
  workspaceId: string;
  committedEventId: string;
  workingHead: StateNodeRef;
}
```

A clean context has `workingHead = { kind: "event", eventId:
committedEventId }`. Each local mutation creates one application whose basis is
the prior working head and atomically advances the pointer. Exact optimistic
concurrency compares the expected and actual `StateNodeRef`.

This removes:

- committed and working frontier rows;
- event/output-frontier identity cycles;
- application-sequence nodes and skip links;
- frontier application counts and membership roots;
- workspace state hashes;
- source-basis selectors built on frontier wrappers.

Application depth and event generation may be maintained as rebuildable indexed
integers for bounded queries. They are not identity and never repair missing
edges.

### 2.4 Workspace events

```ts
interface WorkspaceEvent {
  eventId: string;
  workspaceId: string;
  commandId: string;
  kind: "genesis" | "commit" | "integration-commit";
  workspaceFactRootId: string;
  parentEventIds: string[]; // 0 for genesis, 1 for commit, 2 for integration
  applicationIds: string[]; // complete local chain committed by this event
  decisionIds: string[];
  message: string | null;
  semanticProtocol: string;
  createdAt: string;
}
```

The first parent is the state/content parent. The optional second parent adds
source story and ancestry but does not participate in content composition.
Content is always first-parent projection plus the event's applications.

An integration event must have exactly two parents. Its second parent is the
exact source event whose effective changes were accounted for by reachable
decisions. The event itself is the durable integration claim. Validation can be
re-run from immutable event, application, change, decision, and projection
facts. An `IntegrationProof` may be rendered on demand but is never persisted as
another semantic entity.

### 2.5 Workspace facts and projection

One immutable `WorkspaceFactRoot` is a persistent namespaced map containing:

```text
repository-id/<repositoryId>  -> RepositoryStateId
repository-path/<repoPath>    -> RepositoryStateId   (present repositories only)
file-id/<fileId>              -> FileStateId
```

The root authenticates the map and total entry count. Per-namespace counts are
derived unless a concrete bounded API demonstrates a need for a stored count.

Repository states are:

```ts
type RepositoryState =
  | {
      kind: "present";
      repositoryId: string;
      repoPath: string;
      manifestId: string;
    }
  | {
      kind: "tombstone";
      repositoryId: string;
      priorPresentStateId: string;
      tombstoneChangeId: string;
    };
```

File states are:

```ts
type FileState =
  | {
      kind: "placed";
      fileId: string;
      repositoryId: string;
      path: string;
      contentHash: string;
      mode: number;
      contentKind: "text" | "bytes";
      byteLength: number;
      coordinateExtent: number;
    }
  | {
      kind: "tombstone";
      fileId: string;
      priorPlacedStateId: string;
      tombstoneChangeId: string;
    };
```

A repository manifest is an immutable persistent ordered map from path to
`fileId`. It records structural membership, not file content. The same state
node's workspace fact root resolves the file ID to the exact file state.

Consequences:

- content or mode edits change only the file fact;
- create/delete/move/copy change the affected manifest routes and file facts;
- repository delete removes live path occupancy and installs one repository
  tombstone without manufacturing file tombstones;
- repository restore follows the prior state link and reuses its manifest;
- file restore follows the prior state link and reuses its exact content;
- a file placement beneath a tombstoned repository exists historically but is
  not live; “resident” is therefore not a file-state kind;
- point reads are `(state root, repository state, manifest path, file fact)`;
- historical reads never dereference an old manifest through a newer root.

Content coordinates are intrinsic file-state facts:

- `contentKind` says whether the exact blob is canonical text or opaque bytes;
- `byteLength` is the exact number of stored octets and validates CAS reads and
  materialization receipts;
- `coordinateExtent` is the file length in its semantic coordinate domain;
- `contentKind: "text"` implies UTF-16 code-unit coordinates and records the
  decoded string length as `coordinateExtent`;
- `contentKind: "bytes"` implies byte coordinates and requires
  `coordinateExtent === byteLength`.

The coordinate kind is therefore a pure projection of the exact placed state:

```ts
const coordinateKind = (state: PlacedFileState): "utf16" | "byte" =>
  state.contentKind === "text" ? "utf16" : "byte";
```

Callers never classify a file, choose the unit for blame, or reinterpret an
extent. State identity commits all three intrinsic fields, so a content hash
cannot be paired later with a guessed coordinate system. Text and bytes may
contain identical octets while remaining semantically distinct content states.
The fact is independent of which host, tool, replay, or alarm path observed or
materialized the content; scheduling metadata never participates in coordinate
identity.

The persistent-map implementation is generic. Each root commits its route
strategy (`utf16`, `sha256`, or another small canonical identifier); callers
cannot supply an unauthenticated routing callback. Workspace facts use one
canonical typed-key strategy. Manifests use UTF-16 path ordering for exact
lookup and prefix paging.

### 2.6 Semantic state versus host content

`WorkspaceFactRoot` is the semantic revision source of truth. A host content
root is a derived rendering of the present repositories and placed files in
that root.

Host content hashes are useful for:

- content-addressed blob/tree reuse;
- filesystem observation and content diff;
- builds;
- materialization receipts;
- protected repository refs.

They never select semantic ancestry, prove authorship, or become a semantic
mutation basis. Equal bytes can correspond to different semantic histories.
An applied materialization receipt durably binds a semantic manifest to the
host-derived content root used for later delta projection. Losing a checkout is
a cache miss and changes only cost; losing receipted CAS objects is content-store
corruption and is reported honestly rather than changing semantic history.
The receipt is an exact host observation: it names the materialization, context, target
state, payload digest, and the derived content root for each materialized
repository. It carries no random generation and does not repeat the target
state's workspace-fact root. The private checkout sidecar stores the same
minimal basis plus the complete current repository/root set needed to validate
the next patch. Publication acknowledgements likewise contain only produced
facts (`applied` and `appliedAt`); they do not reserve nullable approval or build
receipt fields for producers that do not exist.

The public read boundary is unambiguous:

- `vcs.readFile({ state, repositoryId, file })` resolves one file from an exact
  event/application and returns its semantic content;
- `fs.readFile(path)` observes a host or materialized filesystem path according
  to the caller's filesystem scope;
- `vcs.readFile` has no `raw` discriminator, host path form, or fallback to
  disk;
- `fs.readFile` does not select semantic history or mint provenance merely by
  observing bytes.

A context-aware filesystem adapter may ensure that a context projection matches
its exact working head before reading it. That is still an `fs` operation over a
verified projection, not a second VCS read path.

---

## 3. Authored work and expressive changes

### 3.1 Work units

A `WorkUnit` is one accepted user/agent intent and the atomic local commit unit.
Because this design commits the entire local chain, work units do not need a
selective staging protocol; their identity remains useful for provenance,
display, and counteraction.

```ts
interface WorkUnit {
  workUnitId: string;
  commandId: string;
  kind: "edit" | "file-transfer" | "lifecycle" | "integrate" | "revert" | "import";
  authoredChangeCount: number;
  authoredChangeIds: string[]; // bounded inspection preview
  incorporatedChangeCount: number;
  incorporatedChangeIds: string[]; // bounded inspection preview
  decisionCount: number;
  decisionIds: string[]; // bounded inspection preview
  externalSnapshot: {
    sourceKind: "git" | "archive" | "filesystem" | "upload" | "generated";
    sourceUri: string;
    snapshotRevision: string;
    snapshotDigest: string;
    targetRepositoryIds: string[]; // exact, sorted, within the descriptor-byte budget
  } | null;
  intentSummary: string | null;
  normalizationProtocol: string;
  createdAt: string;
}
```

`externalSnapshot` is non-null if and only if `kind` is `"import"`. It is part
of that work unit's semantic identity. Internally the normalized snapshot
stores the complete sorted `targetRepositoryIds`, so an identical import that
authors no content change still says exactly which repositories the external
snapshot described. The public work-unit view exposes that complete vector.
All other work units store `null`; there is no detached source node or metadata
table to join. The import's ordinary changes point back to the work unit exactly
as changes from any other command do.

Inspection returns exact adjacency counts and at most 200 inline IDs. The
complete relation is always available through paged `vcs.neighbors` edges such
as `authored-change`; a large import never requires a special summary node or
an oversized response. Each import target is also directly walkable through an
`imports-repository` edge from the import work unit to that repository at the
import application. This is ordinary adjacency derived from the stored target
IDs, not a second import graph.

For agent-caused work, the initiating intent is reached through `commandId` and
the command's exact invocation. Its complete reverse walk is applied change →
change → work unit → semantic command → invocation → turn → trigger message.
The forward walk starts at that same message and reaches every resulting
change. Direct work stops at the command instead. `intentSummary` is an optional
description, not identity, authentication, or a substitute causal root. No
actor, authorship, invocation, turn, trigger message, or intent bundle is copied
into the work unit.

### 3.2 One `Change` replaces atom plus outcome

The previous separate `ChangeAtom` and `SemanticOutcome` layers are collapsed.
A `Change` is both the stable authored semantic contribution and the unit an
integration decision accounts for.

```ts
type ChangeKind =
  | "text-edit"
  | "file-create"
  | "file-delete"
  | "file-restore"
  | "file-move"
  | "file-copy"
  | "file-mode"
  | "content-replace"
  | "repository-create"
  | "repository-delete"
  | "repository-restore"
  | "repository-move";

interface Change {
  changeId: string;
  authoredByWorkUnitId: string;
  operation: number;
  kind: ChangeKind;
  effects: ChangeEffect[];
  counteractsChangeIds: string[];
  effectDigest: string;
  normalizationProtocol: string;
}
```

`effects` permits one semantic change to have coordinated physical effects. A
cross-repository move, for example, removes one manifest route, adds another,
and changes one file placement while remaining one change and one integration
decision subject.

`effectDigest` is intentionally distinct from `changeId`: it recognizes exact
mechanical equivalence between independently authored changes without claiming
shared identity or authorship.

There is no separate outcome ID, origin-atom set, realization identity, or atom
application graph.

### 3.3 Applications and applied changes

A work unit is authored once. An application records its exact realization on
one basis state. Every mutation creates exactly one work unit and one
application; there is no reapplication subsystem:

```ts
interface WorkApplication {
  applicationId: string;
  workUnitId: string;
  basis: StateNodeRef;
  appliedChangeCount: number;
  appliedChanges: AppliedChange[]; // bounded inspection preview
  resultWorkspaceFactRootId: string;
  semanticProtocol: string;
}

interface AppliedChange {
  appliedChangeId: string;
  applicationId: string;
  changeId: string;
  ordinal: number;
  appliedEffects: AppliedEffect[];
  resultPredicate: StatePredicate | null;
}
```

An integration work unit may incorporate source changes without reauthoring
them. Its `incorporatedChangeIds` and application record why and where the
original change was applied; the original change still reaches its original
command causality. The integration work unit has exactly one decision, so its
incorporated-change view is derived from that decision's source-change edges;
it is not a second stored membership list.

Application identity commits the exact basis, applied changes, result workspace
fact root, and semantic protocol. Applied-change IDs are derived
children. The next application points directly to the prior application as its
basis. Ordering and prerequisites are read from that exact chain and change
coordinates; there is no second dependency graph or parallel sequence
membership.

Applied changes are ordinary public nodes in the same provenance graph, not an
internal join hidden behind application previews. `applies-change` connects an
application to each exact applied change; `realizes-change` connects that
basis-specific application to its stable authored `Change`. Immediate
`preserves-content`, `copies-content`, and `incorporates-content` mappings use
applied-change endpoints. They are never projected as change-to-change edges:
two applications of the same authored changes remain two distinct, directly
inspectable lineage paths. A blame terminal's `appliedChangeId` is therefore a
valid `inspect` or `neighbors` root rather than an opaque implementation ID.

### 3.4 One ephemeral projection patch

The planner produces normalized change effects independent of final IDs. After
the command mints work-unit and change IDs, the semantic workspace composes affected
repository/file states and manifests into one ephemeral patch:

```ts
interface ProjectionPatch {
  basisRootId: string;
  expectedFacts: FactExpectation[];
  resultFacts: FactUpdate[];
  manifestChanges: ManifestChange[];
}
```

The patch has no ID, digest, status, or persistence table. Applying it yields
the authenticated `resultWorkspaceFactRootId`, which enters application identity.
There is no `ProjectionIntent`, seal pass, `ProjectionDelta`, synthetic kernel
projection ID, full repository vector, or fallback composer.

---

## 4. Content lineage and blame

### 4.1 Immediate coordinate mappings

All exact content provenance uses one mapping vocabulary:

```ts
interface ContentMapping {
  coordinateKind: "utf16" | "byte";
  childContentHash: string;
  childStart: number;
  childEnd: number;
  parentContentHash: string;
  parentStart: number;
  parentEnd: number;
  digest: string;
}

interface ContentEdge {
  contentEdgeId: string;
  childAppliedChangeId: string;
  parentAppliedChangeId: string;
  relation: "preserves" | "copies" | "incorporates";
  mappings: ContentMapping[];
}
```

One mapping uses one coordinate kind for both child and parent. It cannot
convert bytes to UTF-16 or combine endpoints with different intrinsic content
kinds. Every bound is validated against the corresponding placed state's
`coordinateExtent`; `byteLength` is never used as a text range length. The
mapping digest commits the coordinate kind, both content hashes, and all four
bounds.

Mappings are maximal exact intervals owned by the immediate content edge. Copy,
preservation, and incorporation do not have parallel mapping or traversal
tables.

- a text edit maps every maximal span untouched by the normalized authored edit
  ranges, in UTF-16 units; replaced ranges are authored even when replacement
  text happens to contain equal characters;
- a whole-content byte replacement creates no inferred preservation mapping;
- a move, mode-only change, restore, or explicit copy may map the whole
  coordinate extent when exact content and intrinsic content kind are
  preserved;
- integration records exact mappings only for content it mechanically adopts.

- `preserves` maps unchanged content through an ordinary edit application;
- `copies` maps a new destination file to the exact source state/file
  coordinate selected by an explicit copy;
- `incorporates` maps mechanically adopted source content to the target result.

Influence that cannot be proven as an exact coordinate mapping may be recorded
as a lightweight semantic provenance edge, but it never routes line blame or
counts as integration coverage.

### 4.2 Copy provenance is immediate

An explicit copy records:

```text
copy applied change
  -> ordinary `copies` content edge and mappings
  -> source applied change at the exact authored source state/file
```

The copy change retains the exact source `StateNodeRef`, repository, file, path,
and content hash as its small authored source-coordinate fact. Every application
of that stable change derives an ordinary `copies` edge from that fact; blame
and neighbors then use the same content graph as preservation and integration.
There is no copy-mapping table or copy-specific traversal. It does not enumerate
or snapshot the changes, applications, authors, or contribution digests already
upstream of the source. Copy-of-copy therefore walks naturally. The source fact
also roots the required state and content closure for garbage collection.

Move preserves `fileId` and changes placement. Copy mints a new `fileId` and
retains the immediate source edge. Equal bytes without an explicit copy do not
create copy provenance.

### 4.3 Blame

Blame begins from an exact state, file ID, and bounded `{ start, end }` range.
The file state determines whether those numbers are UTF-16 code units or bytes;
the request does not contain `coordinateKind`:

1. resolve the exact file state and content;
2. derive the coordinate kind and validate the range against
   `coordinateExtent`;
3. find applied-change authored intervals and content edges intersecting the
   requested range;
4. return authored intervals at their applied change;
5. follow preserved/copied/incorporated parent intervals transitively, refusing
   an edge whose unit disagrees with either endpoint state;
6. join terminal changes to work units and commands, continuing to causal
   ingress when the command was agent-caused;
7. when a terminal change belongs to an import work unit, stop at that import
   boundary; inspect the owning work unit for its exact external snapshot and
   make no earlier coordinate-authorship claim.

Results repeat the derived coordinate kind so consumers can render ranges
without guessing. A caller cannot obtain a different answer by labeling the
same numbers with another unit.

Every page is range-bounded and deterministically ordered. A cursor is only a
stateless position within the explicitly repeated typed root; changing the root
starts a new walk. Immutable semantic roots may use simple offsets. The server
does not persist traversal queues, visited sets, or cursor-owned state.

---

## 5. Local incremental integration

### 5.1 Comparison

`compare` accepts an exact target state node and exact source committed event.
It returns a small overview plus pages of source changes:

```ts
type ChangeDisposition =
  | { status: "shared" }
  | { status: "effect-equivalent"; evidence: StatePredicate[] }
  | { status: "actionable"; applicability: "applicable" }
  | { status: "actionable"; applicability: "conflicting" }
  | {
      status: "actionable";
      applicability: "blocked";
      predecessorChangeIds: string[];
    }
  | { status: "accounted"; decisionIds: string[] }
  | { status: "historical" };
```

The source's effective changes are the changes with live result predicates in
its first-parent state history. Explicit counteractions and later coordinate
transitions determine liveness. A second parent contributes story; only changes
actually applied into the first-parent state become downstream state.

The target accounts for a source change when it:

- contains the same live change identity;
- has an active adopted/reconciled/declined decision for that change; or
- contains a later explicit counteraction of that exact change.

Mechanical effect equivalence may produce `effect-equivalent`, but it does not
silently merge identities. The caller records a truthful reconciliation.

Comparison is read-only and creates no lease, source basis, conflict entity,
plan token, or packet proof. Conflict groups are deterministic projections of
the exact bases and are recomputed at mutation time.

Prerequisites are likewise a target-relative projection, never authored or
stored dependency edges. For each effective source change, comparison derives
the exact conditions required to realize it at the target:

- the target-coordinate predecessor endpoint for edit, move, delete, restore,
  mode, and repository transitions;
- presence of the destination repository;
- vacancy of a destination file path, except for the file already occupying
  its own unchanged coordinate;
- vacancy of a destination repository path, except for that repository's own
  unchanged coordinate.

A copy's base endpoint names incorporated source content and is deliberately
not treated as a target predecessor. The comparison checks each condition
against the exact target root. If an unmet condition is established by an
earlier effective source change, the change is `blocked` and names that earlier
change. If the condition is unmet and no earlier effective source change
establishes it, the change is `conflicting`. After the prerequisite is adopted
in an ordinary local step, recomparison naturally makes its dependent
applicable. This one algorithm powers compare, integration admission,
integration-commit completeness, and publication revalidation.

Import work units require no exception in this algorithm. Their repository and
file changes have ordinary endpoints, prerequisites, liveness, and decisions;
the external snapshot tuple explains origin but does not alter applicability.

The retired predecessor refusal returned `blockingChangeIds`. These IDs were an explanation
of the current target/source comparison, not durable dependency membership.
Revert uses the same principle in the opposite direction: it derives later
live changes on the same semantic coordinate and requires them to be
counteracted first. No `dependsOn*`, dependency table, closure cache, or
dependency identity enters the data model or public `Change` record.

### 5.2 Decisions

```ts
type IntegrationDecision =
  | {
      kind: "adopted";
      decisionId: string;
      sourceState: StateNodeRef;
      targetBasis: StateNodeRef;
      sourceChangeIds: string[];
      resultAppliedChangeIds: string[];
    }
  | {
      kind: "reconciled";
      decisionId: string;
      sourceState: StateNodeRef;
      targetBasis: StateNodeRef;
      sourceChangeIds: string[];
      evidence: StatePredicate[];
      rationale: string;
    }
  | {
      kind: "declined";
      decisionId: string;
      sourceState: StateNodeRef;
      targetBasis: StateNodeRef;
      sourceChangeIds: string[];
      rationale: string;
    };
```

Every integration call creates exactly one decision on its one work unit and
application. `resultAppliedChangeIds` is the owning application's applied-change
list. It is the walkable entry point from a decision to the exact target results;
their ordinary provenance neighbors expose any coordinate mappings and source
content. The public decision does not duplicate opaque content-edge IDs that an
agent would otherwise have to stitch back to those applied changes. Only the
applied changes, content edges, and decision source-change edges are stored.
There are no decision-result, decision-content-edge, or decision-supersession
join tables.

Every decision belongs to an integration work unit and reaches its command
through that unit. It does not repeat actor/invocation/turn or store a copied
conflict packet. The exact target basis permits deterministic historical
recomputation.

A reachable decision directly roots and authorizes its source state for the
owning context/forks. There is no `SourceBasisRef` table or selector. Before any
decision exists, deletion of the only authorized source context may make later
integration impossible; that honest lifetime rule is preferable to another
capability object.

### 5.3 Incremental local workflow

Integration is not a session:

1. compare the current working head to a source event;
2. adopt, reconcile, or decline one bounded group of source changes;
3. each call creates an ordinary work unit, decision, application, and new
   working head;
4. edit/test between decisions using ordinary tools;
5. repeat comparison as the target changes;
6. commit whenever useful;
7. create an integration commit only when the source event is fully accounted
   for;
8. push the already committed result later.

Partial integration work may be committed as ordinary first-parent commits.
Those decisions remain local history and continue to account for their exact
source changes. A later zero-content integration event is valid when it merely
adds the source parent after all decisions are complete; it is a semantic
ancestry event, not a fake byte mutation.

There is no begin/continue/abort merge, pending source pointer, conflict file,
or provisional checkout.

### 5.4 Commit and discard are deliberately simple

`commit` commits the complete application chain between the context's committed
event and working head. It does not accept path, repository, file, work-unit, or
application selection.

After commit, both context pointers name the new event. There is no remainder
remapping, selective staging, application-sequence rewriting, commit preview
vector, or dependency-closure selection algorithm.

`discard` drops the complete uncommitted application chain and points working
head back to the committed event. Selective undo is an explicit `revert`/
counteraction work unit, preserving intent and provenance.

This deliberately loses selective commit and focused discard. They may return
only if a real product requirement justifies a new simple model; they cannot be
reintroduced as path staging or a parallel state composition engine.

### 5.5 Integration commit validation

`commit({ integrates: sourceEventId })` performs one exact comparison between:

- target basis: the new event's first-parent result including all local
  applications;
- source: `sourceEventId`;
- reachable decisions in target first-parent history.

Commit first reads the decisions belonging to the local application chain. If
they name a source, they must name exactly one source event; the event is
derived from those recorded decisions rather than trusted from the request. A
caller-supplied source must match that derived event and cannot override it.
Decisions for multiple sources in one local chain, or a mismatched requested
parent, are rejected. When the chain has no decisions, a caller may still name
one source for a zero-decision integration whose changes are already shared or
otherwise need no decision; the same exact comparison must prove completeness.

It refuses if any live actionable source change lacks one compatible active
decision or shared identity. On success it creates an `integration-commit` with
parents `[priorCommittedEventId, sourceEventId]`.

No certificate row, fold root, disposition root, proof digest, or event
certificate backlink is stored. `inspect` can derive and render the validation
summary from immutable facts.

---

## 6. Minimal public surface

The public semantic API should remain small. Variants belong inside canonical
methods rather than becoming dozens of RPC methods.

### 6.1 Mutation methods

```text
vcs.edit              text/binary/create/delete/mode changes
vcs.move              explicit file or repository moves
vcs.copy              explicit file copies
vcs.merge             merge stable source coordinates by net effect
vcs.revert            author explicit counteractions
vcs.commit            commit the entire local chain; optionally integrate source event
vcs.discard           discard the entire uncommitted chain
vcs.importSnapshot    import an exact snapshot as one work unit with ordinary changes
vcs.push              publish the exact committed event
```

Agent filesystem tools expose ergonomic singular `move_file` and `copy_file`
commands that compile to `vcs.move`/`vcs.copy`. Managed raw `mv`/`cp` is rejected
or routed through these commands; it is never reconstructed later from a scan.

Every mutation request supplies:

- `contextId`;
- exact expected working `StateNodeRef` where applicable;
- one globally unique `commandId` for semantic idempotency;
- operation payload;
- optional concise intent summary.

Transport supplies the verified trajectory-invocation parent automatically.
Agent tools derive the command ID from their globally unique invocation; direct
service clients must retain a fresh globally unique ID for an identical retry.
Public request schemas contain no actor, invocation, turn, trigger-message,
authorship, capability, proof, or plan-token field.

Agent attribution is a property of causal ingress, not a separate client tier.
Agent-bound relays without an exact invocation parent are rejected. Authorized
direct human/UI or lifecycle clients may issue commands whose causal walk ends
at that command; this is explicitly unaffiliated with agent intent. No CLI
wrapper, adapter service, or auto-created agent invocation fills the gap.

### 6.2 Read methods

```text
vcs.status            context pointers, clean/working, main relation, compact counts
vcs.compare           overview or one stateless change page
vcs.inspect           one typed semantic node and its bounded direct adjacency
vcs.neighbors         stateless page of incident edges from a typed root
vcs.history           event ancestry or one state-bound file's past changes
vcs.blame             exact state-derived file/range content-lineage projection
vcs.resolveRepository exact state-and-path repository identity lookup
vcs.readFile          exact semantic-state file read
vcs.listFiles         exact paged manifest walk
```

`vcs.resolveRepository` is a direct projection over the authenticated workspace
fact root. It exists so a known path does not require a repository-wide
neighbor/inspect scan; it stores no cache, alias, or second path index.

`vcs.readFile` is semantic-only. Its request always contains `state`,
`repositoryId`, and a typed file ID/path selector. Raw host paths are read by
`fs`; there is no VCS raw variant, filesystem fallback, or `source` tag in the
result.

`inspect` uses a discriminated root union (`event`, `application`,
`applied-change`, `work-unit`, `change`, `decision`, `command`, `file`,
`repository`, `trajectory`,
`trajectory-invocation`, `trajectory-turn`, `trajectory-message`). Inspecting an
import work unit returns its `externalSnapshot` with complete sorted
`targetRepositoryIds` alongside the same immediate command/change adjacency as
every other work unit. Paged `imports-repository` neighbors expose the same
relation as typed edges. Clients do not guess the domain of an opaque string.
`neighbors` returns typed neighboring roots and immediate edge kinds; agents
walk them directly. Inspecting a trajectory invocation projects its canonical
name, lifecycle status, turn, and start/completion event coordinates. Inspecting
the turn reaches the exact trigger-message root; inspecting that message reads
its source identity and exact stored text blocks from the trajectory log. None
of those facts are copied into semantic VCS rows or flattened into an intent or
authorship label.

`blame` uses a range-bound coordinate cursor. Each page traverses only far
enough to emit `limit + 1` terminal spans, and the cursor resumes at the first
unreturned root coordinate. Later pages do not recompute the already returned
prefix or rely on a persisted traversal session.

`history` is deliberately narrower than adjacency. Event roots walk event
ancestry in either direction. A state-bound file root walks only into its exact
past changes, newest first, derived from applications and change coordinates.
Unsupported roots and future-file requests are typed errors rather than empty
answers. This gives file placement/move/mode intent a short route to
`change → work unit → command → trajectory invocation` without manufacturing
edges from one reusable change to unbounded future file snapshots.

There is no persisted BFS continuation, recall-specific VCS façade, certificate
inspector, protected-ancestry inspector, source-basis inspector, or separate
inspect method for every table.

### 6.3 Errors

Keep a small schema-owned discriminated union:

```text
RevisionChanged
Unauthorized
InvalidReference
NoEffect
DestinationOccupied
ConflictPresent
CoupledGroupIncomplete
IntegrationIncomplete
WorkingChangesPresent
CommandIdReuse
ScopeTooLarge
ExternalEffectFailed
IntegrityFailure
```

Structured evidence is preserved through RPC, runtime clients, CLI, UI, and
agent tools. Known failures are never parsed from prose. Do not create a
separate VCS error transport.

### 6.4 Authorization metadata

Schemas that contain semantic references declare reference kind and role at
construction time through stable explicit metadata. Do not walk Zod private
`_def` structures to discover references. The generated request-reference
extractor consumes that declared metadata and fails generation on an
unclassified reference-bearing field.

Reference names use `Ref` or `Coordinate`, not `Capability`, unless possession
of the value itself truly grants authorization. Semantic IDs do not.

---

## 7. Persistence

This is a destructive schema epoch. Recreate the semantic database. Do not
backfill, alias, dual-write, or retain compatibility views.

One shared `WORKSPACE_SYSTEM_EPOCH` fences semantic storage, durable host facts,
and the workspace runtime contract. `meta/vibestudio.yml` declares the exact
same `systemEpoch`; startup rejects a missing or different value before any
workspace runtime starts. Advancing it destructively recreates the semantic
Durable Object and clears the protected publication/ref head in lockstep before
the workspace source is imported again. Old protected event IDs and old
userland runtime protocols must never be accepted, translated, retried as if
transient, or mixed with the new host. Content-addressed blobs may remain as
unreachable cache objects; disposable context projections have their own
explicit filesystem epoch. Structural corruption inside the current epoch
still fails closed.

### 7.1 Authoritative tables

The clean store contains only these semantic groups:

```text
semantic_commands
workspace_contexts
workspace_events
workspace_event_parents
workspace_event_applications
work_units
changes
change_counteractions
work_applications
applied_changes
integration_decisions
decision_source_changes
decision_evidence
repository_states
file_states
repository_manifests
persistent_map_nodes
persistent_map_edges
content_edges
content_edge_mappings
copy_sources
effect_outbox
```

Normalized membership/edge tables are allowed where the listed plural fields
need ordering or indexing. They do not become independent entities.

There are no tables for:

```text
frontiers
working application sequences or skips
source bases
merge certificates
event ancestor sets or transitive closure
semantic invocation authorship
service-call leases/capabilities
provenance continuations
observation witnesses/proofs
projection intents/deltas
publication semantic nodes
atom/outcome/realization compatibility layers
repository/workspace semantic state hashes
copy contribution snapshots
external-history/evidence tables
```

### 7.2 Essential indexes

Indexes serve exact queries but are rebuildable projections:

- event parent and reverse child;
- event generation;
- application basis and reverse child;
- context by committed event/working head;
- event application membership;
- work unit by command;
- change by work unit, kind, durable repository/file identity;
- decision by source state/source change/target basis;
- content edge by child and parent coordinate;
- content mapping by child/parent hash, intrinsic coordinate kind, and bounded
  interval;
- file/repository state identity and tombstone predecessor;
- outbox by command/status.

No index root enters semantic event/application identity unless it is the one
authoritative workspace fact root or repository manifest root.

### 7.3 Exact observations

The semantic kernel remains pure. Store-side compilers provide small typed
operation observations using indexed queries in one consistent transaction.

Completeness is established by query structure and bounded admission:

- point query must return exactly zero or one row as declared;
- finite requested sets compare exact requested and returned keys;
- high-degree adjacency uses `limit + 1` and refuses before truncating a write;
- application chains validate every basis edge to the declared root;
- CAS blobs validate content hash and length;
- semantic validation rejects missing, duplicate, foreign, or contradictory
  facts.

Observation packets contain facts, not proof digests, witness roots,
`contentRequirements`, or self-derived completeness claims.

### 7.4 Idempotency and effects

Semantic SQLite writes are atomic. Host effects use one generic durable outbox:

```text
pending semantic command
  -> semantic rows + final result ref + exact effect payload committed
  -> host applies idempotently
  -> host returns exact receipt
  -> semantic workspace validates receipt and completes command
```

The outbox supports at least:

- materialize context working head;
- publish protected refs.

It is infrastructure, not VCS history. An effect row points to the originating
command. Authorization is deliberately not copied into the semantic outbox or
reconstructed from command causality. The host's existing protected-ref record
is the durable receipt only after an exact publication has been applied.

Crash recovery follows that ownership boundary. Generic outbox recovery may
finish the semantic acknowledgement for an exact publication already present
in the protected-ref store. It must never newly apply an unapplied publication
under synthetic system authority. The original authorized caller retries the
same idempotent command; the trusted workspace lifecycle retries its own exact
initialization operation. A crash before protected CAS may therefore ask for
approval again. That is a deliberate simplification, not a reason to add an
authorization lease, bearer receipt, or recovery capability subsystem. Pending
effects are independent journal entries, not one global queue lock: recovery
selects the first effect it can safely execute or acknowledge and leaves an
unauthorized publication in place while later materializations, observations,
and already-applied publications recover in their existing order.

A context-materialization command is compact and basis-aware. Journaled mutation
effects carry this command as their exact host payload; cache repair derives a
fresh command without creating an effect. It has one of three explicit modes:

- `initialize`, used only for a first projection, requires that no private host
  projection exists and carries the complete present repository set;
- `patch`, used for ordinary local work, commit/discard pointer changes, and
  incremental integration, names the exact prior semantic state and carries
  only affected present/deleted repository identities;
- `replace`, used for fork and derived cache repair, carries the complete present
  repository set and names the exact host state—or exact observed absence—it
  may replace.

For each present repository included in the command it carries exactly one of:

- an already observed immutable content root when the target manifest is known
  to be materialized in the host CAS;
- that immutable basis root plus sorted changed-path upserts and deletes;
- a one-time sorted snapshot when no observed basis exists.

Only newly authored content blobs accompany the command. Paths, blob identities,
and bytes participate in its digest. For a patch, the host requires its private
projection state to name the exact prior semantic state, merges the changed
repository roots into that disposable full projection record, and projects or
removes only the affected repositories. It returns roots only for changed present
repositories. The semantic workspace validates and records each manifest/root
binding in an indexed relation as a materialization fact; it does not predict a
host root, scan historical receipts, or serialize unchanged repository trees.
Receipts have one strict normalized shape, canonical content roots, and no
unknown pseudo-fact fields. Repair never replays an old partial patch or
impersonates a journal effect: the semantic workspace derives a fresh,
self-contained replacement from the current semantic state and the host's exact
observed repair basis. The host executes it directly, without an effect row or
acknowledgement.

The complexity contract is explicit: first import, fork, and repair may be
`O(workspace)`; an ordinary edit/move/copy/integration/discard step is
`O(changed paths)` plus projection of the affected repositories; and a commit
with unchanged facts is an empty patch that advances only the projected state
identity. A command must not expand every manifest or enumerate every
repository merely because the checkout is a whole-context view. Protected-main
publication carries CAS entries only for changed repositories while the
aggregate basis and result digests still compare the complete ref set atomically.

---

## 8. Ownership and host boundaries

The semantic workspace Durable Object is the single owner of:

- contexts and exact state-node pointers;
- workspace events and parentage;
- work units, changes, applications, decisions, and content lineage;
- workspace facts and manifests;
- comparison/integration planning;
- command journal and effect outbox.

The server-side VCS orchestrator consumes semantic outbox effects through two
narrow internal host-effect ports:

```ts
interface WorkspaceContentPort {
  readDigests(...): Promise<VerifiedContentReceipt>;
  describeDigests(...): Promise<IntrinsicContentReceipt>;
  materialize(...): Promise<MaterializationReceipt>;
}

interface PublicationGate {
  approveAndCompareSwap(...): Promise<PublicationReceipt>;
}
```

These are server-local dependency interfaces over existing owners, not public
services, reverse RPC services, or a second VCS. There is no `vcsAuthority`
schema/service. The host never
imports or branches on changes, decisions, conflicts, integration completeness,
file identity semantics, or event ancestry.

Build execution is deliberately absent from these ports. The build subsystem is
an ordinary consumer of an exact semantic/content source. A caller may request
an explicit build of a context working head for advisory feedback, and runtime
reconciliation may request a build after publication. Neither form is a VCS
effect, approval receipt, semantic fact, or precondition for protected refs.

Host reads and explicit snapshot capture belong to the ordinary filesystem
owner. Through `importSnapshot`, the semantic workspace accepts a source URI,
snapshot revision, and complete repository/file source facts naming CAS blobs:
path, content digest, and mode. The content observation port supplies intrinsic
content descriptors, and the semantic workspace derives the snapshot digest
from the combined normalized facts. It does not accept a root or digest
assertion, expose a raw VCS read, or delegate to a VCS-branded host observation
service. Import uses `describeDigests`, so raw blobs never round-trip through
semantic execution. A text edit instead uses `readDigests` for only the exact
prior blobs whose coordinate edits must be evaluated; the generic host port is
selected by representation, not by a VCS method name. The content port above
also materializes semantic projections.

The semantic DO performs no host filesystem/ref effect directly and does
not call back into the server. It journals an exact effect and returns a pending
effect descriptor. The existing server VCS request orchestrator executes the
matching owner-shaped local port and acknowledges the exact receipt to the DO;
the DO validates that receipt and completes the command. On retry, the
orchestrator asks the DO for the same pending effect and resumes it. Neither side
holds a Durable Object transaction or global concurrency gate across external
I/O.

Disposable projection repair is intentionally outside that mutation outbox. The
server reports only the context and exact materialized basis it observed; the
semantic DO returns `vcsContextMaterializationCommand`, a deterministic full
replacement for the context's current working head. The host validates and
executes it directly. This derived cache command is never wrapped in a
pending/applied effect and is never acknowledged.

### 8.1 Managed filesystem

A context checkout is a materialized cache of its exact working head. Semantic
commands update semantic state first, then journal one compact materialization
effect. That effect names the complete repository target vector but transfers
only roots already present in the host CAS, exact deltas from observed roots,
or the first snapshot for a genuinely unknown repository. Context correctness
is whole-view; transfer and projection work are incremental.

- semantic reads may use the exact store directly;
- directory/search ergonomics may use disk only after verifying its projection
  marker against the context head;
- external drift is observed and either imported explicitly as expressive
  changes or refused;
- no scanner guesses moves, copies, intent, or authorship from before/after
  bytes;
- scratch-only filesystem scopes remain explicitly non-semantic.

### 8.2 Startup

Startup creates or opens one semantic workspace and one empty genesis event. It
never turns an implicit disk scan into an anonymous main baseline, submits a
synthetic agent mutation, or starts a legacy VCS host beside the semantic DO. A
fresh workspace with declared source content remains empty until a real agent
tool invocation or the authorized startup owner submits one explicit
`importSnapshot` command. An agent import has the full trigger-message spine; a
direct startup import stops honestly at its command. Either way, the import boundary
makes the exact source tuple and imported bytes walkable without pretending
startup was an author.

Publication has no dependency on a workspace-defined builder. This is a
load-bearing bootstrap invariant, not a genesis exception: in a fresh system
epoch, source and protected refs must be publishable before any source-defined
build provider or runtime artifact could exist. The same publication semantics
apply to genesis descendants and mature workspaces. Once source is published,
build subscribers may derive artifacts; none may retroactively decide whether
that source event was published.

Source partitioning is total and fail-closed. Every managed path must belong to
exactly one declared repository; a file placed directly in a repository
container such as `workers/README.md` is a layout error, not an empty
repository and not silently ignored content. An explicitly imported empty
repository is valid: it initializes and authenticates the canonical empty file
manifest directly. Manifest composition remains a mutation primitive and must
continue rejecting an effect-free update.

Runtime code selection follows the same semantic boundary. A worker or Durable
Object owned by a context defaults to that context's exact working state;
protected `main` is selected only by an explicit `ref: "main"` or by a declared
workspace singleton that intentionally follows main. Persisted runtime images
are derivations keyed by their semantic state and are rebound when the selected
state changes. A host checkout, file mtime, or cache timestamp is never a
code selector and is never silently imported. Source-development startup must
either use a freshly seeded workspace or submit checkout bytes through an
explicit provenance-bearing semantic import; it may not run new host code
against an old workspace runtime contract.

One startup panel/process remains the product orchestration owner. This VCS
cutover may simplify how it obtains the semantic provider, but it must not
redesign unrelated panel lifecycle or build infrastructure.

### 8.3 Context identity and real-time delivery

Context binding is identity, not reach or materialization state. The public
`.vibestudio-context.json` contains exactly the binding protocol,
`workspaceId`, and `contextId`. It never stores `serverUrl`, credentials,
semantic heads, receipts, or agent attribution. Host crash-recovery data, when
needed, lives in the private disposable `.gad/context-materialization.json`
receipt. CLI sessions name the durable workspace by `serverId + workspaceId`;
workspace display names and loopback endpoints are never identity.

Context initialization uses one stable semantic command per workspace/context,
not a host-session nonce. If its disposable folder is absent or stale, the host
requests an exact materialization repair command for the context's current head;
rebuilding a projection never authors a semantic command and cannot replay an
old head over newer work. The request includes the observed host state—or exact
absence—as an optimistic basis. The semantic workspace derives a self-contained
`replace` command, and the host rechecks that basis under the materializer lock
before executing it. Repair does not retrieve an old journal effect, fabricate
an `applied` effect, or send an
acknowledgement. Its private receipt is disposable host basis state only.

A paired client has one device identity, a stable hub control reach, and one
replaceable workspace reach. Pairing invite and durable device control rooms
terminate at the hub. The fresh authentication result carries the issued
device credential plus the exact one-time `PairingContext.workspaceId` selected
by the invite. The client routes that ID over the same control connection and
receives only the selected child's `workspaceReach`; switching workspaces
replaces that reach without replacing control ingress. Workspace children own
only workspace device/user rooms. They do not redeem invites, activate proposed
credentials, or host a second control plane.

No target is inferred from a workspace display name, `srv`, last-opened state,
or an available child. There is no `controlReach` route field, child pairing
activation journal, proposed credential, transport capability, compatibility
reader, or migration path. `PairingContext` is exact routing context, never
authorship or agent intent.

Server-side launch preparation returns declarative data, not absolute paths or
a server-local URL for a remote client to reinterpret. The client materializes
any local launch profile it owns and cleans it up with that launch.

RPC owns the exact delivery session. A long-lived routed subscription is a
stream whose terminal owns unsubscribe on graceful cancellation, abrupt socket
close, or replacement by a newer reconnect generation. PubSub stores durable
subscription/domain state; it has no independent heartbeat, stale-roster
inference, reconnect budget, periodic call-redelivery loop, or delivery-session
registry. Transport connection identity describes how a causal call travelled;
it is never authorship or agent intent.

The generic event surface follows the same rule. `events.watch([topics])`
returns one NDJSON `Response`; cancelling or losing that response removes its
exact topic membership, and transport recovery reopens the caller's desired
watch. Direct delivery addresses the already-authenticated live transport
session and does not create a durable event participant. There are no unary
subscribe/unsubscribe methods, server-to-client callback retries, persisted
watch handles, or application heartbeats layered on Iroh.

An externally linked agent attachment is likewise one long-lived
`openBridge()` response. The response stream carries the initial attachment
receipt plus bridge events; its terminal is the single detach fact. Reconnect
opens a replacement response fenced from late cancellation of its predecessor.
The durable delivery queue and cursor survive that response, but neither is
used to infer whether the process is alive. There are no `attach`,
`heartbeat`, or `detachSelf` control calls and no timeout-based attachment
lease.

WebSocket upgrade authorization also follows one commit point: a non-101
upstream response remains provisional until refresh/retry policy selects it.
Discarded stale 401 responses never commit headers, body, or socket state to the
downstream client; the selected terminal response is streamed with backpressure.

---

## 9. Protected push

Push publishes an already committed event. A context with uncommitted
applications must commit or discard first.

The semantic workspace state machine:

1. resolves current main event and proposed context committed event;
2. verifies main is reachable through immutable event parents;
3. validates every traversed non-first-parent integration event directly from
   its decisions and applications;
4. writes one publication effect to the outbox;
5. asks `PublicationGate` for approval and atomic compare-and-swap of the
   complete protected-ref set;
6. validates the receipt and atomically advances semantic main to the proposed
   event;
7. completes the command.

Push does not invoke, wait for, or certify a build. Tests, typechecks, and
builds are explicit advisory operations against an exact state. They can inform
the agent or human deciding whether to push, but their results grant no
authorization and move no ref.

The protected value is the semantic main event together with its materialized
repository refs. A newly published event therefore passes the gate even when
its repository snapshot is byte-for-byte identical and its changed-ref list is
empty. That approval names the exact previous and proposed event IDs instead of
inventing a file diff. Only replay of the same already-applied publication ID
skips the gate. Generic host calls and restart recovery carry no publication
authority; the sole caller-free exception is the trusted workspace lifecycle's
exact first snapshot publication.

Parent reachability uses exact bounded recursive queries over the event DAG.
There is no persistent ancestor set, `ProtectedAncestryProof`, inspection handle,
path digest, or merge certificate. A derived path can be returned for diagnosis
or recomputed after a crash.

The protected-ref store owns its applied effect receipt and current head effect
ID. It does not need `VcsInvocationTable`: the effect already points to its
originating semantic command, whose cause is durable.

### 9.1 Build and activation projections

After protected refs advance, build subscribers may derive content-addressed
artifacts for affected units. These are projections of the published event,
not descendants in its event DAG and not evidence that publication was valid.
Their diagnostics remain queryable by that exact source event.

Runtime activation is a separate fail-closed state transition. A newly derived
artifact becomes runnable only after its own build, validation, approval, and
startup requirements succeed. If any requirement fails, the published source
and protected refs remain unchanged, the failed artifact stays inactive, and
the previous runnable artifact remains selected. Repair is ordinary new local
work followed by commit and publication; neither source rollback nor a special
publication retry path is implied.

---

## 10. External imports

### 10.1 An import is ordinary semantic work

An import creates exactly one work unit with `kind: "import"` and one normal
committed event. The work unit carries one required `externalSnapshot` value:

```ts
interface ExternalSnapshot {
  sourceKind: "git" | "archive" | "filesystem" | "upload" | "generated";
  sourceUri: string;
  snapshotRevision: string;
  snapshotDigest: string;
  targetRepositoryIds: string[]; // complete, sorted, internal identity
}
```

It authors the same change vocabulary used everywhere else: repository create,
file create, file delete, file mode, and whole-content replacement. A complete
snapshot of an existing repository is compared with the exact basis and emits
only the ordinary changes needed to reach the imported tree. A new repository
emits its repository-create and file-create changes. There is no
synthetic import change or effect, synthetic all-files change, imported pseudo
event, or import-only application path.

This shape matters operationally. Imported changes appear in ordinary
`compare` pages, can be adopted or reconciled through small local `integrate`
steps, and can be counteracted by ordinary `revert`. Git and other importers do
not need a special merge protocol. An import with no tree or mode change still
records its import work unit and event, including a possibly new external
revision, but authors no fake content change. Existing coordinate lineage then
continues to point to the earlier work that actually established the bytes.

The normalized snapshot stores and inspection returns the complete sorted
repository-ID vector even when the import authors no changes. The single
canonical descriptor-byte budget bounds that vector; there is no independent
repository-count invariant and no duplicate count or preview.
`imports-repository` neighbors expose the same relation as walkable typed edges
to each repository at the import application.

Counteracting a repository creation is dependency-safe. Every currently
contained file must either have its exact creation counteracted in the same
request or already be absent; otherwise the counteraction reports the exact
conflicting live coordinates. Repository deletion never becomes a shortcut
that hides unselected later work.

The command carries complete normalized repository/file source facts with exact
paths, content digests, and modes. It does not accept intrinsic content kind or
length claims, a caller-authored repository tree hash, content-root assertion,
or snapshot digest. The semantic workspace derives `snapshotDigest` from those
source facts plus host-observed intrinsic descriptors in canonical
repository/path order and stores it in the work unit. The source URI identifies what the
importer observed; the revision identifies the source's own coordinate; the
digest commits exactly what Vibestudio admitted.

Persist a canonical credential-free URI. Embedded passwords, access tokens,
ephemeral signed query parameters, and machine-local checkout paths remain
transport details, never provenance. A Git importer stores the canonical
remote. Represent a local-only source with a durable opaque digest rather than
leaking its machine path. Source URI and revision are source-observed evidence,
not cryptographically verified identity, authorization, or native authorship.

### 10.2 Exact content admission

Source bytes enter the content-addressed store through the ordinary filesystem
owner before semantic admission. `importSnapshot` consumes complete source facts
whose content digests name that CAS. Before committing, the semantic workspace
asks the existing content port to observe each distinct digest. The host content
owner verifies that the digest exists and returns only its intrinsic content
kind, byte length, and coordinate extent; it does not copy the blob into the
semantic process. Semantics validates that exact intrinsic receipt and enriches
every matching file fact with it. This keeps byte authority in one place and makes import cost
proportional to the descriptor rather than the combined content size. The
semantic workspace does not read a host path itself, accept a caller root, or
gain a raw-read variant. One agent tool invocation may capture the source and
issue its one semantic command.

Import classifies every blob once and stores that classification in the placed
file state. Decode the complete byte sequence as UTF-8 with fatal error
handling. If and only if decoding succeeds, store `contentKind: "text"`, the
octet count as `byteLength`, and the decoded JavaScript string length as
`coordinateExtent`. On any malformed UTF-8 sequence, store
`contentKind: "bytes"` and set both lengths to the octet count. Extension, MIME,
NUL-byte, replacement-character, and caller-provided heuristics do not
participate. The rule is identical for filesystem, Git, archive, upload, and
generated imports.

One import remains one atomic semantic transaction regardless of repository or
file count. Repository and file arrays must be in strict canonical path order,
each path component is at most 255 UTF-8 bytes, and a complete file path is at
most 512 UTF-8 bytes. Those path bounds define canonical identities; they are
not a proxy for operation capacity. Existing manifests are traversed through
bounded pages so database query limits remain an implementation detail instead
of leaking into the public contract. There is no whole-descriptor byte ceiling,
arbitrary item cap, chunk assembler, upload session, partial import graph, or
hidden staging service.

Path admissibility is also one semantic invariant, implemented by one pure
predicate used by public schemas, semantic admission/resume, Git adapters,
host scanners, and the materialization sink. It rejects non-canonical or
over-budget paths, `.git`, `.gad`, the host context-binding file, and exact
credential-bearing filenames such as `.env`, which common tooling automatically
consumes. Project configuration such as `.npmrc` is ordinary tracked source;
secrets belong in the credential store rather than repository configuration.
Templates such as `.env.example` remain ordinary source. The predicate does not reject ordinary tracked names such as `dist`,
`out`, `release`, `coverage`, `.cache`, `node_modules`, logs, or archives. A
filename convention is not evidence that project content is disposable.

A whole-content replacement from an external snapshot is exact about both
endpoints but does not invent a preservation mapping between them. Byte or text
similarity is not proof of coordinate continuity. Explicitly unchanged files
need no change; exact mappings already present in their lineage remain intact.

### 10.3 An honest epistemic boundary

There is one provenance graph and four useful levels of knowledge:

1. native mappings, ordinary changes, work units, commands, and trajectory
   edges provide exact native coordinate and causal provenance;
2. an import work unit provides the exact external snapshot through which its
   authored repository/file state entered the workspace;
3. external facts queried elsewhere remain labelled evidence at their actual
   granularity and never become native line blame;
4. absent evidence remains explicitly unknown.

There is no evidence-quality enum, per-path last-touch table, imported author,
external source node, external commit graph, or optional evidence mini-graph. A
shallow Git clone is sufficient when it identifies the requested revision and
exact tree. The importer neither walks reachable Git history nor attributes
individual paths to HEAD. A separately observed “last commit touching this
path” may be described as path-level external evidence, but this epoch does not
persist it: without an exact coordinate mapping it cannot participate in blame.

Blame walks ordinary mappings and changes. When its terminal change belongs to
an import work unit, it reports an import-boundary stop. That stop is a derived
explanation, not a stored change kind. Inspect the terminal change, then its
owning work unit, then its command and causal ingress. The work unit exposes
`sourceKind`, `sourceUri`, `snapshotRevision`, and `snapshotDigest`; the command
and trajectory expose why and by whose agent intent the import was performed.
Neither proves who authored a pre-import line. An honest answer says that
pre-import coordinate authorship is unknown.

Later native edits, moves, copies, and integrations retain their full ordinary
lineage and intent. The boundary is terminal only for history Vibestudio did
not observe; it does not weaken provenance after import.

An agent-caused import requires the same exact causal invocation as edit or
commit. An authorized direct importer records a direct command instead. Do not
create an “import adapter” invocation to make automation appear agentic.

Git export and publication are interchange projections. Vibestudio's semantic
workspace state machine remains the source of truth for events, changes, and
provenance.

---

## 11. Agent and developer ergonomics

The normal agent workflow is:

```text
status
  -> read/edit/move/copy/revert in the current context
  -> compare when bringing in another event
  -> integrate one small group at a time
  -> run tests
  -> commit the complete local chain
  -> push the committed event when requested
```

Agents should not need to understand storage roots, manifests, application
depth, content-edge rows, or command journaling to perform ordinary work.
Responses return concise summaries and typed roots that can be passed directly
to `inspect`, `neighbors`, `history`, or `blame`.

For managed authoring, prefer the in-agent tools because their real tool-call
invocation supplies the causal edge automatically. Use external or linked CLI
surfaces for orientation and diagnostics unless they are demonstrably executing
inside an already authenticated invocation. A mutation refusal is the intended
boundary, not a prompt to invent an adapter.

The current linked-Claude bridge has no such mutation surface. Claude's native
Edit/Write/Bash hooks journal an exact trajectory invocation and request, but that
hook observation is asynchronous evidence; it is not an invocation-scoped execution
port and cannot safely authorize or causally bind a later CLI process. Consequently an
agent-token CLI may inspect managed state, channels, and provenance, while managed
`fs`/`vcs` mutations and `eval` fail closed. Native writes to a materialized context
folder only dirty rebuildable projection bytes and are unsupported. Linked sessions
remain useful as reviewers and conversation peers until a single canonical
invocation-scoped MCP tool surface exists. Do not bridge this gap with environment IDs,
ambient "current invocation" state, a watcher, or post-hoc filesystem reconstruction.

That semantic refusal is paired with a real host boundary: supported linked-Claude
sessions launch only through an OS sandbox with the context projection mounted
read-only and a disposable explicit scratch root writable. Unmanaged plugin/adoption
is deleted because an MCP child cannot contain its already-running parent. A platform
without the audited sandbox backend fails the launch; prompt instructions, permission
mode, and `chmod` are not accepted as substitutes.

Linked intent is still exact and walkable. A received channel message opens a linked
turn with `turn.opened.causality.messageId` pointing directly to the already-canonical
message; detached replay preserves that same ID rather than minting a mirrored prompt.
A terminal `UserPromptSubmit` stores the exact prompt message first and uses its ID as
the turn trigger. `PreToolUse` stores Claude's structural `tool_input` as the canonical
`invocation.started.request`; bounded output text remains a diagnostic summary, not an
exact result claim. A `Stop` without either captured input is rejected instead of
inventing a causal turn.

The API should make the intended action obvious:

- changing bytes is `edit`;
- preserving identity while changing location is `move`;
- minting identity with source lineage is `copy`;
- undoing intent is `revert`;
- accepting source work is `integrate/adopt`;
- binding source intent to another truthful result is `integrate/reconcile`;
- intentionally rejecting it is `integrate/decline`.

No skill teaches raw managed `mv`/`cp`, marker resolution, merge sessions,
staging, source-basis tokens, certificate inspection, authorship fields, state
hashes, or manual graph packet assembly.

---

## 12. Skills documentation cutover

Skills are production clients and ship in the destructive epoch. The
`skill-creator` workflow is used to revise existing skill packages after the
public schema stabilizes.

### 12.1 Sources of truth

1. Service schemas own exact callable request/result/error shapes.
2. This document owns semantic invariants and entity meaning.
3. The canonical VCS skill owns the shortest safe agent procedure.
4. Domain skills link to the canonical VCS procedure and do not redefine it.

Generated references project schemas. They are never hand-maintained copies of
the API.

### 12.2 Required skill structure

The canonical VCS skill must teach, in its always-loaded `SKILL.md`:

- contexts contain one committed event and one working head;
- edits and integrations are ordinary incremental local applications;
- commit commits the complete local chain;
- explicit move/copy preserve their distinct identity semantics;
- compare returns changes, not file-diff staging candidates;
- typed roots are directly walkable through inspect/neighbors/history/blame;
- file history reaches placement and structural change intent, while blame
  reaches content intent;
- invocation inspection exposes canonical turn/tool lifecycle coordinates,
  never copied request or authorship payloads;
- the complete intent walk is trigger message → turn → invocation → globally
  unique semantic command → work unit → change;
- `vcs.resolveRepository` directly resolves one known path at one exact state;
- `vcs.readFile` is semantic-only and raw host reads use `fs`;
- agent-bound relays retain their exact authenticated invocation parent, while
  authorized direct operations stop honestly at their command;
- command IDs are retained across uncertain retries;
- typed failures, especially `RevisionChanged`, require re-observation.

Linked references provide:

- concise API examples generated from schemas;
- integration decision examples;
- move/copy/revert examples with resulting provenance;
- provenance and blame walkthroughs;
- push/approval behavior;
- the import work unit's required external snapshot tuple, its ordinary
  changes, honest blame boundary, and explicitly unknown pre-import authorship;
- recovery recipes by typed error.

### 12.3 Repository-wide instruction audit

Update or delete stale VCS guidance in:

- `skills/vibestudio-agent/` and its distributed copy;
- workspace development, app development, extension development, sandbox, and
  system-testing skills;
- AgentDO and architecture references;
- Git bridge guidance;
- CLI help and generated service references;
- onboarding/system prompts and fixture hints.

A release search rejects surviving instruction text for legacy methods and
concepts. Do not retain deprecation prose that teaches an unavailable path.

### 12.4 Vague fixture tests

Headless fixtures prompt a fresh agent in ordinary language without method
names or request fields. At minimum:

1. reorganize managed files and preserve move identity;
2. copy a file and explain why blame walks into the source;
3. edit copied and original files independently and inspect lineage;
4. bring a source context into a target through multiple local decisions,
   commit, and push;
5. revert one intention without restoring unrelated bytes;
6. recover from a stale working-head CAS;
7. trace an imported line to its terminal change and owning import work unit,
   report the exact external snapshot, and explain the honest unknown beyond it;
8. recover from a stale managed edit without reusing an idempotency identity for
   a changed request.

Validators check outcomes and provenance, not a rigid tool-call sequence.
Failures are classified as infrastructure, documentation, harness, validator,
or model behavior. Platform defects are fixed rather than hidden by making the
prompt prescriptive.

---

## 13. Recovery implementation sequence

### Phase A — Freeze and delete duplicate semantic owners

1. Delete agent authorship capability/lease and agent invocation open/close.
2. Project trigger message → turn → invocation in the existing trajectory log
   and attach only the verified invocation coordinate at semantic ingress.
3. Remove actor/invocation/turn copies from semantic requests and rows.
4. Authorize caller/context reachability once in the existing VCS service and
   delete transported/replayed semantic `authority` snapshots.
5. Delete `vcsAuthority` and `VcsInvocationTable`.
6. Keep authorization and approval separate from causal provenance.
7. Make semantic command IDs globally unique and stable across identical
   retries; derive agent-tool command IDs from the tool invocation.
8. Reject an agent-bound relay that drops its exact causal invocation; preserve
   authorized direct commands as direct rather than adding adapter invocations.
9. Add boundary tests proving nonexistent and cross-trajectory causal
   coordinates are rejected and that causality grants no authorization. The
   trusted vessel remains responsible for selecting the actual parent among
   existing invocations on its bound trajectory.
10. Delete standalone claim tools, claim ledger/relation tables, `knowledge.*`
    event kinds, and claim-specific recall. Preserve intent on the causal facts
    that actually produced or decided work.

Exit criterion: one mutation command reaches one existing transport/trajectory
cause with no durable authorship/capability registry or authorship payload.

### Phase B — Normalize exact state

1. Delete frontier entities and use event/application `StateNodeRef`.
2. Change contexts to committed event plus working head.
3. Delete application sequence and state hashes.
4. Implement one namespaced workspace fact root.
5. Change manifests to path-to-file-ID.
6. Normalize placed/tombstone file states and present/tombstone repository
   states with predecessor links.
7. Delete projection Intent/seal/Delta and full-vector composition.
8. Keep one generic authenticated persistent-map implementation.

Exit criterion: edit one file in a large workspace by reading/writing only
bounded map paths, and derive host content from the resulting semantic root.

### Phase C — Collapse semantic records

1. Replace atom/outcome with `Change`.
2. Replace atom application/realization with `AppliedChange` plus exact result
   predicate.
3. Normalize preservation/copy/incorporation into one content-edge graph and
   one mapping table.
4. Keep only the copy change's immediate authored source state/file coordinate;
   derive each application's ordinary `copies` edge from it.
5. Keep work units, applications, changes, and decisions independently
   inspectable through direct adjacency.

Exit criterion: edit, move, copy, delete, and revert produce expressive,
walkable records and exact blame without transitive snapshots.

### Phase D — Simplify local history and integration

1. Make every mutation append one application to the context working head.
2. Make commit consume the complete local chain.
3. Make discard drop the complete local chain.
4. Delete selective commit, remainder remapping, focused discard, staging, and
   application sequence planning.
5. Make decisions point directly to source state.
6. Delete source bases and merge certificates.
7. Derive prerequisite ordering from exact target facts, source order, and
   semantic coordinates; delete stored dependency graphs and fields.
8. Validate integration commits directly from event/application/decision facts.

Exit criterion: a fixture can integrate a source through several local calls,
test between them, create one integration event, and inspect every step.

### Phase E — Walkable provenance

1. Delete observation witness/proof digests.
2. Delete event ancestor caches and provenance continuation state.
3. Implement `inspect` and stateless paged `neighbors` over typed roots.
4. Implement focused history and blame over the same immediate edges.
5. Remove redundant specialized inspectors and recall façades.

Exit criterion: every response root is directly followable without parsing an
ID, loading a whole graph, or allocating server traversal state.

### Phase F — Narrow effects and push

1. Connect content materialization and publication through the two narrow
   host-effect ports. Delete build from VCS orchestration.
2. Use the generic effect outbox for materialization and publication.
3. Make first materialization snapshot-based and later materializations use
   sparse exact repository-state receipts or exact changed-path deltas. When a
   sparse basis is unavailable, derive one repository snapshot by paging its
   exact target facts; never copy every unaffected repository receipt into each
   new workspace state.
4. Bind `(workspaceFactRootId, repositoryId)` coordinates to host-derived
   content roots in exact receipts. A file manifest authenticates placement,
   not bytes, and must never serve as a content-state cache key. Verify every
   projected target against the exact state-addressed binding.
5. Remove VCS semantics from host adapters.
6. Validate protected ancestry through event parents and integration facts.
7. Delete protected-ancestry proof objects and separate publication rows.
8. Make explicit context builds advisory and make post-publication builds
   independent subscribers. Ensure runtime activation fails closed and retains
   the previous runnable artifact on build, validation, approval, or startup
   failure.
9. Failure-inject semantic-write/effect/ack crash windows, including lost delta
   receipts and a missing host basis after restart. Separately verify that a
   missing or stale temporary checkout is repaired from a newly derived exact
   command without an effect row or acknowledgement.

Exit criterion: lost replies and process restarts converge exactly once without
an in-memory registry or second semantic owner.

### Phase G — Public surface, Git, and skills

1. Replace the broad public contract with the minimal methods in §6.
2. Generate runtime, CLI, tool, UI, and documentation clients from that schema.
3. Make every external import one ordinary `import` work unit with the required
   external snapshot tuple and ordinary repository/file changes. Delete the
   synthetic barrier change, optional external-evidence subsystem, special
   integration/revert behavior, and caller-authored tree/root assertions.
4. Rewrite canonical and domain skills under §12.
5. Delete legacy docs, generated artifacts, methods, and examples.
6. Add vague headless fixtures.

Exit criterion: a fresh agent discovers and uses the system from skills without
legacy hints or low-level eval workarounds.

### Phase H — Verification and fresh review

Run, in order:

1. identity/canonicalization unit tests;
2. persistent-map structural-sharing/property tests;
3. change planner and content-lineage tests;
4. semantic workspace/store tests;
5. RPC/runtime/tool contract parity tests;
6. context edit/move/copy/commit/discard/integrate integration tests;
7. publication crash/replay tests;
8. package type checks and repository architecture guards;
9. headless infrastructure doctor;
10. smallest exact vague agentic fixtures;
11. category fixtures;
12. smoke coverage.

Then give a fresh reviewer the finished plan and implementation with these
questions:

- Does any stored fact merely duplicate a traversable fact?
- Is any cache, cursor, digest, proof, or capability acting as a second source
  of truth?
- Can an agent move from every returned root to its immediate causes and
  effects?
- Are local integration steps ordinary context work until commit/push?
- Did simplification damage move/copy/revert meaning or ordinary ergonomics?
- Is any legacy path, compatibility branch, or second VCS still present?

Integrate valid feedback destructively and repeat affected tests.

---

## 14. Acceptance matrix

### Causality

- Trusted agent vessels preserve the causal parent of each concurrent tool
  invocation; semantic mutation does not infer causality from timing or an
  ambient "current invocation."
- A nonexistent or cross-trajectory log/head/invocation coordinate is rejected
  before mutation. Selecting the correct existing invocation within one bound
  trajectory remains the trusted vessel's responsibility; this design does not
  add a bearer capability merely to harden that internal correlation.
- The exact agent causal walk is trigger message → turn → invocation → globally
  unique semantic command → work unit → change.
- An agent-bound mutation without an exact invocation coordinate is rejected;
  an explicitly authorized human/UI/lifecycle mutation records a direct command
  and its causal walk stops there without a synthetic agent edge.
- Eval/subagent work reaches its exact spawn/tool chain.
- No actor/invocation/turn is repeated on event, work, change, application, or
  decision rows.
- Agent intent walks trigger message → turn → invocation → command → work unit
  → change/applied change; no authorship payload participates in that walk.
- For agent-caused work, event/decision reasons and the exact triggering message
  are the discoverable intent record; direct work has no fabricated message.
  No detached claim can self-assert another trajectory parent.
- A file's focused past history reaches the exact placement/move/mode change;
  content blame terminals reach the exact content change.
- Invocation inspection exposes canonical name/status/turn/event coordinates
  without copying prompt or request content into VCS storage.
- Causal reachability alone never grants context write or push authorization.

### State and identity

- A committed state is addressed by event ID; a local state by application ID.
- Clean contexts point working head at committed event.
- Each application basis equals the previous working head.
- Equal semantic roots may exist in distinct event histories without collapsing
  events.
- Content/mode edit leaves repository manifest identity unchanged.
- Every placed file state commits `contentKind`, `byteLength`, and
  `coordinateExtent`; byte content requires equal byte length and extent.
- Move preserves file ID; copy mints file ID; delete/restore walks predecessor
  state.
- Repository delete/restore does not manufacture file deletion history.

### Local work

- Multiple edits/integration decisions append ordinary applications.
- Commit includes the complete local chain and leaves the context clean.
- Discard drops the complete local chain.
- Selective undo is an explicit counteraction with provenance.
- No path/repository staging or remainder planner exists.

### Integration

- Adopt applies original change identity through exact incorporation mappings.
- Reconcile records truthful exact state evidence and rationale.
- Decline records rationale and no fake content mutation.
- Partial decisions remain local ordinary history.
- Integration commit refuses while any effective source change is unaccounted.
- The event itself contains all facts needed to recompute its claim.
- Downstream comparison does not reopen source changes already absent or
  settled in the source first-parent state.

### Provenance and blame

- Every applied change reaches its work unit and command. Agent-caused commands
  additionally reach the exact invocation, turn, and trigger message; direct
  commands stop honestly at the command.
- Preserved text blames through immediate content mappings.
- Text mappings cover only spans untouched by authored edit ranges and use
  UTF-16 units on both endpoints.
- Blame derives its coordinate kind from the exact file state; callers cannot
  select or relabel the range unit.
- Malformed UTF-8 imports are byte content and valid UTF-8 imports are text
  content under one source-independent rule.
- Copy blame walks through the exact source state and copy-of-copy chain.
- Move history preserves identity without inventing content authorship.
- Import work units carry the required exact external snapshot tuple and author
  only ordinary repository/file changes.
- Blame reports an import boundary when its terminal change belongs to an
  import work unit; inspection then walks change → work unit → command/intent.
- Whole-content import replacement creates no guessed coordinate mapping, and
  no parallel external-evidence graph exists.
- Neighbor pages are deterministically ordered and require no server
  continuation row.

### Boundary and durability

- Workspace manifest, semantic store, protected refs, and runtime host share
  one exact destructive system epoch; mismatches fail before readiness.
- Workers and Durable Objects follow their owning context state by default;
  protected main requires an explicit pin or declared main-following singleton.
- Runtime image state/build metadata names the exact semantic state it was
  derived from; host checkout bytes and cache age never select executable code.
- Explicit builds are advisory observations and post-publication builds are
  derived projections; neither authorizes or blocks `vcs.push`.
- Runtime activation fails closed: a failed new build, validation, approval, or
  startup retains the previous runnable artifact without rolling protected refs
  back.
- Public context bindings contain durable identity only; endpoints and host
  materialization receipts are absent.
- CLI session identity survives a workspace rename and rejects a same-named
  recreated workspace with a different `workspaceId`.
- RPC stream termination is the sole owner of real-time unsubscribe; PubSub has
  no heartbeat, stale-session inference, or second reconnect policy.
- `events.watch` and linked `openBridge` use the same response-owned lifetime;
  neither maintains an application heartbeat or a second liveness lease.
- A stale WebSocket authorization response can be discarded before downstream
  commitment, and a reconnect generation cannot be closed by its predecessor.
- Semantic code invokes no filesystem/ref effects directly and does not
  orchestrate builds.
- Host ports contain no semantic change/decision/integration branching.
- Recoverable pending materialization and publication effects retry
  idempotently after every crash window without being starved by an earlier
  unapplied publication that still needs its original authority; missing or
  stale context projections derive and execute a fresh exact repair command
  without replaying journal state.
- A request that derives a future wake does not succeed until the one durable
  alarm row is written. The driver lists due rows without consuming them and
  clears/replaces a row only after the handler outcome is durably acknowledged.
- The workspace lifecycle owner admits an alarm only while the matching Durable
  Object entity is active, in the same transaction that writes the wake. Entity
  retirement clears its alarm, and startup removes any stale retired-entity row
  left by a prior crash, so a late caller cannot resurrect runnable work.
- Alarm dispatch has no best-effort outcome flag. Normal runtime eviction owns
  idle object lifetime; an object never aborts its own alarm and asks the driver
  to reinterpret that failure as successful garbage collection.
- Push refuses dirty working state.
- Push validates ancestry and integration, obtains approval, and atomically
  updates protected refs; it has no build precondition or genesis exception.
- A content-identical push still approves and advances the semantic main event;
  only exact durable replay is approval-free. Generic host execution is never
  publication authority, and initial workspace publication has one explicit
  lifecycle-only path.
- Protected refs and semantic main converge through one durable outbox effect.
- No in-memory authorship, capability, or publication registry participates in
  correctness. Ephemeral active-call correlation is lifecycle state only.

### Deletion guards

Repository searches and architecture tests reject production references to:

```text
agentAuthorship
agentInvocation.open
agentInvocation.close
vcsAuthority
VcsInvocationTable
external_sources
external_path_evidence
StoredWorkspaceFrontier
resultWorkspaceStateHash
ApplicationSequence
SourceBasis
MergeCertificate
ProtectedAncestryProof
provenance_continuations
proofDigest on semantic observations
ProjectionIntent
ProjectionDelta
atom/outcome/realization compatibility tables
copy contribution digests
gad_claims
gad_claim_relations
gad_knowledge_ledger
knowledge.claim_*
record_claim / relate_claims / revise_claim / retract_claim
serverUrl in public context bindings
PubSub heartbeat / stale-session eviction / reconnect counters
merge markers or pending merge state
```

Generic uses of words such as “application,” “proof,” or “capability” in
unrelated domains are not rejected. Guards target exact symbols and behavior.

---

## 15. Final invariant

The whole system should be explainable as one walk, with the first line present
only for agent-caused commands:

```text
an exact trigger message opened a turn whose tool invocation caused one
globally unique semantic command—or an authorized direct operation began at
that command without a synthetic agent;
the command authored or incorporated changes in one work unit;
an application applied those changes to an exact prior event/application;
the result was committed as an event or remained local in the context;
content lineage maps every preserved/copied/incorporated coordinate to its
immediate predecessor;
integration decisions explain which source changes the target accepted,
reconciled, or declined;
push published an already committed event through an approval-gated durable
effect.
```

If an implementation concept cannot be placed on that walk as a new immediate
fact, it is a derived view, a cache, or unnecessary. Delete it.

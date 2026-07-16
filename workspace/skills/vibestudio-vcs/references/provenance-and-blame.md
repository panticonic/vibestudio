# Provenance and blame

## Start from a typed root

Use roots returned by VCS responses or construct a schema-valid root with an
explicit kind: event, application, applied-change, work-unit, change, decision,
command, file, repository, trajectory, trajectory-invocation, trajectory-turn,
or trajectory-message. Never guess a node kind from an opaque ID.

Use the four walk surfaces deliberately:

- `inspect` returns one node and a bounded preview of direct edges;
- `neighbors` pages immediate incident edges;
- `history` projects committed event ancestry from an event root;
- `blame` traces one exact file range through content-coordinate mappings.

Pass `nextCursor` only with the same root and query. Traversal state belongs to
the client; the server does not retain a search session.

The focused `provenance` agent tool composes these reads: it renders the selected
node's semantic fields before one exact adjacency page. For a file root it also
renders a bounded past-history preview with exact change IDs and summaries. Its
result details retain the typed node and edge endpoints. Prefer it for ordinary
orientation; use direct VCS reads for custom adjacency, history pagination, or
range tracing.

## Read immediate semantics

Common edges explain:

- which command caused a work unit;
- which applications apply work and basis-specific applied changes;
- which stable authored change each applied change realizes;
- which work unit authored or incorporated a change;
- which decision accounts for a source change;
- which change counteracts another;
- which exact state/file endpoint an explicit copy named when it was authored;
- which exact content coordinates preserve, copy, or incorporate earlier
  content;
- which event committed applications and which events are parents;
- which exact trajectory invocation caused a command and which trajectory
  contains that invocation.

The causal spine is explicit and bidirectional at every incident read:
trigger-message ↔ turn ↔ trajectory-invocation ↔ semantic-command ↔ work-unit
↔ change. Applications reach the work unit through `applies-work` and their
basis-specific applied changes through `applies-change`; `realizes-change`
connects each applied change to the stable authored change. Content-coordinate
edges connect applied changes directly, so independently applying the same
authored change never collapses distinct lineage. Inspect the invocation using
the complete `logId` +
`head` + `invocationId` endpoint; it points to its turn, and that turn points to
the exact message that triggered it. Invocation name, status, terminal outcome,
start/completion event references, and the immutable request blob reference are
recorded facts, not an authorship bundle carried through service calls. The
command ID is globally unique and records semantic admission/idempotency; it is
not an actor credential.

Trajectory-message inspection returns the exact stored text blocks and source
message and sender identities from the canonical sanitized trajectory log. It
does not read a copied VCS intent field or expose arbitrary participant
metadata. Provenance reads follow the workspace's documented mutual trust
boundary, like channel replay; mutation still requires context authorization
and an agent-bound mutation also requires its exact causal invocation.

Invocation inspection returns `requestRef`, never hydrated request JSON. The
reference is immediately walkable through the existing per-workspace blobstore:
inside `eval`, call
`await services.blobstore.getText(invocation.requestRef.digest)`. Do that only
when exact tool arguments are necessary and the caller already has blob-read
authorization. Tool arguments can contain sensitive content. Check `size` and
`originalBytes`; for large values prefer `services.blobstore.stat`, `getRange`,
or `grep` and avoid copying the full payload into conversation or provenance.
This dereference uses the ordinary workspace blob-read trust boundary; the VCS
service neither broadens access nor creates another payload store.

Executor, initiating intent, approval, content origin, and blame are different
walks over these facts. Agent intent walks trajectory-invocation → command →
work-unit → change, while application edges identify where that work was
applied. The same incident edges support the reverse walk. Do not expect or
supply one transported author field to answer all of them.

## Trace content

Call `blame` with an exact state, repository/file identity, and bounded
`{ start, end }` range. Do not choose a coordinate kind. The exact placed file
state derives it: text uses UTF-16 code units; opaque content uses bytes. The
service validates the range against that state's `coordinateExtent` and repeats
the derived kind once on the blame result.

Preserved edits walk through `preserves-content`. Copies walk through one
`copies-content` edge per generation. Integrated content walks through
`incorporates-content`. Moves change placement without creating content
origin. These are the same applied-change graph: blame and applied-change
neighbors do not switch to a copy-specific lineage model.

Do not confuse that mapped content lineage with `authored-copy-source`. The
latter is a semantic change-to-file relation that answers which exact source
coordinate the copy command selected. It carries no range mappings and never
appears as a blame step. `copies-content` is schema-valid only between two
applied changes; `authored-copy-source` is schema-valid only from a change to a
typed file root. Walking either endpoint returns the identical canonical edge.

Every lineage mapping uses that same intrinsic unit on child and parent. Text
edit mappings cover only maximal spans outside the authored edit ranges;
coincidentally equal text inside a replacement is not silently reclassified as
untouched. A mapping that changes units or exceeds either state's extent is an
integrity failure. Page large ranges rather than asking for an unbounded trace.
The opaque blame cursor is bound to the exact requested range and resumes at
the first unreturned coordinate; reuse it only with the same state, file, and
range.

Each blame span's `path` contains only the exact content-mapping route between
applied-change nodes. Its terminal `appliedChangeId` is itself a valid
`inspect`/`neighbors` root; follow `realizes-change`, then the terminal
`changeId`, `workUnitId`, or `commandId` to reach semantic intent and the causal
trajectory invocation. The service does not duplicate those causal edges into
every blame span.
Use the terminal change's `authoredByWorkUnitId` for the exact ownership join.
Do not require that change to appear in a work unit's bounded authored-change
preview; page `authored-change` neighbors only when full membership is needed.

## Explain a decision

Inspect the decision, walk `decides-change` to source changes, and walk back to
the work unit, application, command, and trajectory as needed. Reconciled and
declined decisions include rationale; adopted decisions lead to the applied
target changes and incorporation edges.

Report what the graph proves. Import has one deliberate terminal condition:
blame calls an ordinary terminal change an import boundary when its owning work
unit has `kind: "import"`. Inspect that change, then the work unit. Its
`externalSnapshot` exposes the source kind, canonical credential-free URI,
snapshot revision, and snapshot digest derived by the semantic workspace. Continue to
the work unit's command and causal ingress when the question includes importer
intent. Quote the work unit's recorded intent summary when the user asks what
intent is actually known; do not replace it with a plausible reconstruction.

Those are exact snapshot-level facts about the accepted import descriptors,
not line authorship. There is no per-path external evidence graph. Say that
earlier coordinate origin is outside semantic history instead of attributing it
to the importer, revision committer, or current agent. Native edits after the
boundary retain their ordinary intent and causal chain; the boundary limits
only what Vibestudio can claim about earlier history.

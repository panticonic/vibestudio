---
name: provenance-orientation
description: Orient in Vibestudio's semantic VCS graph from an exact session, managed file, event, application, work unit, change, decision, command, trajectory invocation, or typed node. Use when origin, causation, incorporation, copy lineage, integration decisions, external import boundaries, what is actually known, or history could change the next action.
---

# Provenance orientation

Read the canonical [Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) before
walking code history. Provenance is the adjacency of the same semantic VCS
records used for editing and integration, not a parallel memory product.

## Start with the smallest exact question

Use the friendly tool for a session, managed path, or known semantic identity:

```ts
provenance({ target: "session" });
provenance({ target: "packages/example/src/index.ts" });
provenance({ target: "change:…" });
```

The tool resolves a managed path to the current exact state and stable file
identity, inspects the selected node, then calls `vcs.neighbors`. Its compact
`node · …` line appears before the direct edges so intent, command state, and
invocation metadata are visible without a second lookup. For a file it also
shows a small exact `vcs.history` preview of the changes that touched that stable
identity; continue from a returned change node into the causal graph.

It accepts these semantic shorthands:
`event:`, `application:`, `work-unit:`, `change:`, `decision:`, and `command:`.
Pass `inspect.root`, `neighbors.root`, or either endpoint of a returned edge as
`root` unchanged. The inspected `node` is a value view, not a reusable root.
Invocation, turn, and message roots require their complete typed
`{ kind, logId, head, ...Id }` coordinate returned by an edge; their local IDs
alone are not global graph coordinates.

Call provenance at a real decision boundary: before relying on unfamiliar code,
integrating another context, explaining an edit, or attributing copied content.
A normal file read is enough for a mechanical change whose history does not
matter.

## Read immediate edges literally

Each page contains direct typed edges. Important kinds include:

- `caused-by` from work unit to command and, for agent-caused work, from command
  to the exact trajectory invocation that caused it. A fully paged direct
  command with no invocation edge is an honest causal endpoint;
- `part-of-turn` from an invocation to its exact turn, and `triggered-by` from
  that turn to the exact message that opened it;
- `applies-work`, `applies-change`, `realizes-change`, and `authored-change` for
  application, basis-specific realization, and authored-work structure;
- `imports-repository` from an import work unit to every exact repository state
  targeted by its external snapshot;
- `incorporates-change`, `decides-change`, and `counteracts` for
  semantic relationships;
- `preserves-content`, `copies-content`, and `incorporates-content` between
  applied-change nodes for exact coordinate mappings;
- `parent-event`, `committed-by`, `places-file`, and `contains-repository` for
  workspace structure.

Do not flatten executor, cause, initiating intent, authorization, and content
origin into one “author” value. Walk the relevant edges for the question.

## Choose the focused public read

- `vcs.inspect` returns the exact reusable `root`, one inspected value, and a
  bounded adjacency preview.
- `vcs.neighbors` pages immediate edges without hidden traversal state.
- `vcs.history` pages committed ancestry from an event root or past changes to a
  stable file identity at an exact state. It is not a second general graph walk.
- `vcs.blame` traces one exact file range through content-coordinate mappings.

Continue `neighbors` with the same root and returned cursor. If a question
changes, begin a new read. Never parse an ID, manufacture a node kind, query
private semantic tables, or add a client-side graph cache.

## Trust by walking to recorded evidence

An edge says what the system recorded; it does not make every upstream claim
true. For consequential conclusions, continue to the exact change, work unit,
decision, command, event, or trajectory evidence. Inspecting a work unit exposes
its `intentSummary`; inspecting a command exposes its method and terminal state;
inspecting the typed trajectory-invocation endpoint exposes its canonical tool
name, turn, status, outcome, and start/completion event references. Continue to
the turn for its bounded summary and then to the triggering message for its
exact stored text blocks and original channel-message identity. This is the
observable intent evidence: do not invent private reasoning, an actor, or an
authorship assertion from it. Bulky tool arguments remain in the invocation's
canonical trajectory event rather than being copied into the bounded VCS node;
the command, work unit, and changes show what semantic action was admitted and
what actually happened.

A copy should reach its immediate source coordinate; repeated walks may then
reach the original edit. An integration explanation should reach the decision
and source changes it accounted for. Channel delivery remains canonical in the
trajectory log and is projected through the typed message node; do not create a
parallel VCS copy or cross-system provenance façade.

When blame reports an import boundary, inspect its terminal ordinary change,
then the owning import work unit. Report that work unit's `externalSnapshot`—
its `sourceKind`, `sourceUri`, `snapshotRevision`, and `snapshotDigest`—as
snapshot-level facts. Its `targetRepositoryIds` vector is the exact complete
target set, including an identical import with no authored change;
`imports-repository` neighbors expose the same relation as pageable typed
edges. URI and revision
are source-observed; the digest commits the descriptors the semantic workspace
verified and admitted. Continue through the work unit's command to the causal
invocation and triggering message when
importer intent matters, and quote the work unit's exact `intentSummary` rather
than reconstructing intent from effects. The terminal change's ownership field
is the exact join; its presence in a bounded authored-change preview is not
required. State that earlier coordinate authorship is unknown:
importer intent explains why the bytes entered Vibestudio, but it does not make
the importer, external revision committer, or current agent their author.

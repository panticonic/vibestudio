# Semantic workspace epoch — July 2026

Vibestudio is pre-release. The July semantic-workspace cutover is a destructive
data epoch, not a compatibility migration. A clean install and an upgraded
development workspace start from the same empty semantic schema. Superseded
implementation history lives in version control, not in runtime adapters or
agent instructions.

The authoritative design and deletion guards are in
[`provenance-aware-diff-merge-plan.md`](provenance-aware-diff-merge-plan.md).
This register states the resulting product contract.

## Persistence epoch

- Semantic workspace, trajectory, claim, recall, and derived projection data
  reset together so no knowledge survives without its causal evidence.
- Contexts store one committed event and one exact working head.
- Immutable workspace events, work units, changes, applications, applied
  changes, decisions, content edges, workspace facts, commands, and durable
  effects make up the stored graph.
- Stable repository and file identities survive moves. Copy creates a new file
  identity connected to its exact source coordinate.
- The workspace-fact root is semantic state. Content trees are rebuildable
  materialization and build projections.
- No stored compatibility shape is normalized into the current graph.

## Public VCS protocol

The sole public VCS contract is generated from `vcsMethods` in
`@vibestudio/service-schemas`. It contains eighteen methods:

```text
edit move copy integrate revert commit discard importSnapshot push
status compare inspect neighbors history blame resolveRepository readFile listFiles
```

Mutation inputs carry a stable command ID, context ID, and exact expected
working head. They do not carry actor, turn, invocation, authority, or proof
payloads. Runtime transport attaches verified causal ingress automatically.

Ordinary local work follows one path:

```text
status
  -> edit / move / copy / revert
  -> compare and integrate in small local steps when needed
  -> test
  -> commit the complete local application chain
  -> push the committed event when publication is intended
```

There is no separate staging operation. Use another context when work needs a
different commit boundary. Discard removes the complete uncommitted chain;
selective undo is an explicit `revert` of named changes and remains visible in
history.

## Integration contract

- Compare uses an exact target state and one committed source event.
- Source changes are classified as shared, already satisfied, actionable,
  accounted, or historical.
- Each integrate call records one adopted, reconciled, or declined local
  decision and advances only the target context's working head.
- Agents may inspect and test between integration steps.
- An integration commit names the source event as its second parent only after
  all effective source changes are accounted for.
- Event parentage, applications, changes, and decisions contain all durable
  integration evidence.
- Push publishes an already committed event and never creates ancestry.

## Provenance and filesystem behavior

- Exact causal ingress connects a trajectory invocation or authenticated
  request to the semantic command it caused.
- Work units and changes reach that command; actor and turn are derived by
  walking the trajectory edge.
- Immediate content edges record preservation, copy, and incorporation.
- Managed writes record semantic state first, then materialize the resulting
  context state to disk.
- Managed move and copy operations are explicit so the filesystem adapter never
  infers identity from timing or equal bytes.
- A context checkout is a cache of its exact working head. External drift is
  imported explicitly or refused.

## Host boundary

The semantic workspace Durable Object owns meaning, history, comparison,
integration, provenance, and the durable command/effect journal. It does not
perform host I/O.

The server orchestrates three narrow owner-local capabilities:

- materialize exact workspace content;
- build exact derived content;
- approval-gate and atomically update protected refs.

Effects are journaled before execution and acknowledged with exact receipts.
Retry resumes the same effect. These host ports do not inspect semantic change
kinds, make integration decisions, or mint provenance.

## Git interchange

Git is external transport, not workspace ancestry.

- Import accepts a canonical credential-free source URI, source-observed exact
  revision, and complete repository/file descriptors naming CAS bytes.
- The semantic workspace verifies those descriptors and derives the snapshot
  digest. One import work unit retains URI, revision, and digest together while
  authoring ordinary repository/file changes.
- Git ancestry and per-path commit metadata stay in Git; shallow history does
  not invalidate an exact snapshot.
- Blame reports an import boundary when its terminal ordinary change belongs to
  an import work unit, then inspection reaches that work unit's snapshot tuple.
- Export renders accepted workspace events into Git without making Git commits
  semantic parents.

## Skills and clients

- `workspace/skills/vibestudio-vcs` is the canonical agent procedure.
- Its public contract is generated from the service schema.
- Domain skills link to the canonical procedure and add only domain guidance.
- Runtime, CLI, harness, Git bridge, panels, and fixtures use the same method
  names and typed roots.
- Agent guidance teaches event/application heads, complete-chain commit,
  incremental integration, explicit move/copy, typed graph walking, and stable
  command IDs.

## Release verification

The epoch is ready only when:

- semantic identity, persistent-map, expressive-change, content-lineage,
  integration, idempotency, and authorization tests pass;
- service-schema/runtime/tool catalogs have exact parity;
- materialization and publication survive injected crash/retry windows;
- architecture guards find no second semantic protocol or host-side semantic
  decision path;
- generated skill references are current;
- vague headless fixtures can discover edit, move, copy, integration, revert,
  provenance, commit, and push from the shipped skills;
- a fresh review finds every stored fact walkable to its immediate causes and
  effects.

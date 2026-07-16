---
name: vibestudio-vcs
description: Operate Vibestudio's semantic workspace VCS for managed edits, explicit file or repository moves, provenance-preserving copies, incremental context integration, whole-chain commit or discard, revert, honest external snapshot import, history, blame, protected-main publication, and exact agent causality. Use when changing managed workspace content, bringing work from another context, explaining where content or intent came from, recovering a stale or uncertain VCS request, or publishing committed work. Do not use for scratch-only filesystem work or unrelated Git repositories.
---

# Vibestudio VCS

Treat source history and provenance as one small, walkable graph.

## Remember the state model

- Treat a context as one committed event plus one working head.
- Expect a clean working head to name the committed event. Expect each local
  edit or integration step to return a new application state.
- Keep the returned working head and use it as the expected basis of the next
  mutation. Never substitute a path, content digest, or moving selector.
- Commit or discard the complete local application chain. Split work into
  another context when it must have an independent commit boundary.
- Treat repositories and files as stable identities. A move preserves identity;
  a copy mints identity, records one typed `authored-copy-source` endpoint, and
  derives mapped `copies-content` lineage when applied.
- Treat content coordinates as facts of the exact file state. Text ranges use
  UTF-16 code units; byte ranges use bytes. The service derives that unit and
  never accepts a caller-selected blame classification.
- Treat compare results as semantic changes. Integrate small groups locally,
  test between steps, and commit only when the context tells one coherent story.
- Follow typed roots with `inspect`, `neighbors`, `history`, or `blame`. Do not
  parse IDs or reconstruct a hidden graph from response prose.
- Explain agent intent with the exact causal spine: trigger message → turn →
  invocation → semantic command → work unit → change. Applications connect to
  work through `applies-work` and to each basis-specific applied change through
  `applies-change`; every applied change reaches its stable authored change
  through `realizes-change`. Walk the same immediate edges in reverse from a
  result. Never look for or supply an authorship payload.
- Observable intent evidence is the exact trigger text and sender, optional turn
  summary, invocation lifecycle and exact request reference, admitted command,
  optional work summary, and actual effects. Private model reasoning is neither
  persisted nor inferred.
- Keep invocation requests opaque by default. When exact tool arguments matter
  and the caller already has workspace blob-read authorization, read
  `requestRef.digest` with `services.blobstore.getText`; use `stat`, `getRange`,
  or `grep` for large values and never echo sensitive bulk unnecessarily.
- Treat each semantic command ID as globally unique. Agent tools derive it from
  the real tool invocation; neither request fields nor credentials stand in for
  that causal edge. Never pass authorship or invocation capabilities in the
  public mutation payload.
- Use `vcs.readFile` only for an exact event/application state. Use `fs` for a
  host or projected filesystem read; there is no raw VCS read mode.

## Use the shortest workflow

Inside a workspace agent, use the compact `vcs` tool for `status`, `compare`,
one-step `integrate`, `revert`, whole-chain `discard`, path-friendly `blame`, and `push`. Its input is
always `{ operation: ... }`; it is not the lower-level `vcs.*` service client. Use the
dedicated `edit`, `write`, `move_file`, `copy_file`, and `commit` tools for the
common authoring actions. This workflow uses agent adapters; the later public
contract section separately lists the canonical `vcs.*` service methods used by
authorized runtime clients. Both surfaces record the same semantic operations.
An agent-bound relay must retain its exact
authenticated tool-invocation parent for every mutation. An authorized direct
human/UI or lifecycle client may instead issue a command whose causal walk ends
honestly at that command. Never invent a wrapper agent or adapter invocation to
make a direct operation appear agent-authored.

1. Call `vcs({ operation: "status" })`. The tool binds the current context and
   returns `workingHead`, `committed`, and `mainEventId` in its details.
2. Read or list managed files at that exact state. Keep repository and file IDs
   returned by the service.
3. Author ordinary content changes with the focused `write`/`edit` tools. Use
   `move_file`/`copy_file` for identity operations. Use
   `vcs({ operation: "revert", changeIds: [...] })` to counteract named changes.
4. To bring in another context, call
   `vcs({ operation: "compare", sourceEventId })` against its committed event,
   then call `vcs({ operation: "integrate", sourceEventId, decision })` once per
   small adopt, reconcile, or decline decision. Continue from every returned
   working head and re-run `compare` until no effective source change remains
   actionable, conflicting, or blocked; the final page should show each decided
   change as `accounted` by the decision identity you just received.
5. Run relevant typechecks, tests, or explicit context builds while the work
   remains local. These checks are advisory observations, not publication
   authority.
6. Call `commit({ message })` to commit the complete local chain. Commit derives an
   integration source from the chain's recorded decisions; if an agent tool
   call also passes `integratesEventId`, it must name that same event. Use the
   explicit source for a zero-decision integration. If the complete local chain
   is unwanted instead, call `vcs({ operation: "discard" })`; it derives the
   live head and command identity exactly like the other compact mutations.
7. Call `vcs({ operation: "push" })` only when the user wants the clean committed event published.
   Push validates semantic ancestry and integration, obtains approval, and
   atomically advances protected refs. It neither runs nor certifies a build.

Every mutation carries a globally unique `commandId` and an exact expected
basis. Agent tools derive both from the current invocation and live context;
do not add either field to an agent-tool input. When making a direct causally bound service
call, mint it once and retain it. Reuse that ID only when retrying an identical
request whose response is uncertain. If re-observation changes the request or
its expected working head, use a new command ID.

Branch on typed error codes. On `RevisionChanged`, call `status`, re-read the
affected facts, and re-plan from the returned working head. Never parse a
message string to choose recovery.

## Discover exact call shapes

Use `await help("vcs")`, the live service schema, or the generated
[public contract](references/public-contract.md). Do not guess methods or copy
request schemas into operational prose. The public surface is:

```text
edit  move  copy  integrate  revert  commit  discard  importSnapshot  push
status  compare  inspect  neighbors  history  blame  resolveRepository  readFile  listFiles
```

## Load only the needed reference

- Read [contexts and state](references/contexts-and-state.md) for exact event
  and application coordinates.
- Read [authoring basics](references/authoring-basics.md) for managed reads and
  edits.
- Read [file move and copy](references/file-move-copy.md) before changing a
  managed file's location or identity.
- Read [compare and integrate](references/compare-and-integrate.md) before
  bringing in another committed event.
- Read [revert](references/revert-counteractions.md) before undoing intent.
- Read [commit, discard, and push](references/semantic-commit.md) at a local or
  publication boundary.
- Read [provenance and blame](references/provenance-and-blame.md) to explain
  causes, decisions, incorporation, copies, or line history.
- Read [external snapshot import](references/external-snapshot-import.md) for
  Git, archive, upload, filesystem, or generated ingress, and whenever blame
  reaches an import boundary. The snapshot tuple lives on the owning import
  work unit; there is no barrier change to find.
- Read [checks and publication](references/checks-and-publication.md) for
  advisory checks against the current context and the protected publication
  boundary.
- Read [typed recovery](references/typed-recovery.md) after a refusal, stale
  basis, or lost response.
- Read [worked scenarios](references/scenarios.md) for end-to-end examples.

## Finish deliberately

Before reporting success, verify the final working head is the one returned by
the last mutation, every requested integration change has a truthful decision,
move/copy returned the intended file identity semantics, and the context is
clean after commit or discard. If publication was requested, verify `push`
returned the published event and new main event.

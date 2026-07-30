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
- An ordinary in-agent `read` of managed text automatically appends bounded
  **workspace memory** explaining why the displayed lines exist. The
  attachment is derived from `vcs.readMemory` for the exact bytes; agents do
  not select tiers or keywords. Answer from it when it is conclusive. Use its
  copyable `provenance({ target })` continuation only when deeper context can
  change the answer or action.
- Inside an agent, browse ordinary paths with `ls`, `find`, and `read`. Those
  tools share the same context-scoped filesystem as injected JavaScript `fs`
  and resolve semantic working state and repository boundaries in the
  background. Direct runtime clients may use `vcs.listDirectory` or
  `vcs.listFiles` when code explicitly needs semantic entry identities or a
  paged flat repository manifest.

## Use the shortest workflow

Inside a workspace agent, use the compact `vcs` tool for `status`,
typed-root `inspect`/`neighbors`, `compare`,
one-step `integrate`, `revert`, whole-chain `commit` or `discard`,
path-friendly `blame`, and `push`. Its input is
always `{ operation: ... }`; it is not the lower-level `vcs.*` service client. Use the
dedicated `edit`, `write`, `move_file`, and `copy_file` tools for path-friendly
authoring actions. This workflow uses agent adapters; the later public
contract section separately lists the canonical `vcs.*` service methods used by
authorized runtime clients. Both surfaces record the same semantic operations.
An agent-bound relay must retain its exact
authenticated tool-invocation parent for every mutation. An authorized direct
human/UI or lifecycle client may instead issue a command whose causal walk ends
honestly at that command. Never invent a wrapper agent or adapter invocation to
make a direct operation appear agent-authored.

1. Call `vcs({ operation: "status" })`. The tool binds the current context and
   returns `workingHead`, `committed`, and `mainEventId` in its details.
   Browse paths with `ls`, `find`, and `read`; inside eval use the injected
   `fs` package. The filesystem layer resolves the exact live working state in
   the background. Walk exact typed graph roots returned by semantic operations
   with `vcs({ operation: "inspect", root })` or
   `vcs({ operation: "neighbors", root, after })`; copy the root unchanged.
2. Read or list managed files at that exact state. Keep repository and file IDs
   returned by the service.
3. Author ordinary content changes with the focused `write`/`edit` tools. Use
   `move_file`/`copy_file` for identity operations. Use
   `vcs({ operation: "revert", changeIds: [...] })` to counteract named changes.
4. To bring in another context, call
   `vcs({ operation: "compare", sourceEventId })` against its committed event,
   then call `vcs({ operation: "integrate", sourceEventId, decision })` once per
   small adopt, reconcile, or decline decision. Continue from every returned
   working head and re-run `compare` until `resolution.complete` is true and
   `resolution.remainingChangeCount` is zero. Adopted changes normally become
   `shared` because the exact source identity is now live in the target;
   reconciled or declined changes become `accounted` by the returned decision
   identity. `accounted` is one narrow disposition, not the overall completion
   signal. Never adopt a change classified as `actionable/conflicting`; author
   the truthful merged target result, then reconcile it with path-based exact
   evidence as shown in [compare and integrate](references/compare-and-integrate.md).
5. Run the relevant exact-context build report while the work remains local.
   Treat its structured typecheck diagnostics as the primary repair packet:
   fix the cited file/position, rerun the same check, and repeat until it is
   clean. The protected-main gate repeats this check against the exact
   candidate state and its affected dependency closure, so a local check is
   fast feedback while the push gate is the authoritative final check.
6. Call `vcs({ operation: "commit", message })` to commit the complete local chain. Commit derives
   every integration source from the chain's recorded decisions, so several
   subagent integrations can become one multi-parent event. If an agent tool
   call also passes `integratesEventIds`, its exact set must match those
   sources. Use one or more explicit sources for a zero-decision integration;
   omit the field instead of passing an empty array for an ordinary commit. If
   the complete local chain is unwanted instead, call `vcs({ operation: "discard" })`; it derives the
   live head and command identity exactly like the other compact mutations.
7. Call `vcs({ operation: "push" })` only when the user wants the clean committed event published.
   Push validates semantic ancestry and integration, runs the exact-candidate
   build/typecheck gate, obtains approval, and atomically advances protected
   refs. A typecheck or build failure is a publication refusal; inspect its
   diagnostics, repair locally, recommit, and retry from the new exact event.

Every mutation carries a globally unique `commandId` and an exact expected
basis. Agent tools derive both from the current invocation and live context;
do not add either field to an agent-tool input. When making a direct causally bound service
call, mint it once and retain it. Reuse that ID only when retrying an identical
request whose response is uncertain. If re-observation changes the request or
its expected working head, use a new command ID.

Branch on typed error codes. On `RevisionChanged`, call `status`, re-read the
affected facts, and re-plan from the returned working head. Never parse a
message string to choose recovery. A workspace-dev scaffold wrapper reports a
post-commit push refusal as `scaffold_publication_failed`; inspect its nested
typed VCS code and exact retry policy, and do not rerun repository creation.
`fixed-code-not-requested` names the installed caller whose own manifest lacks
the publication request. Do not add that capability to the repository being
published: a target panel/package manifest cannot authorize the agent or worker
performing the push. Use a caller that declares `workspace-main-advance`, or
stop and repair that caller's manifest before retrying.

## Discover exact call shapes

Use `await help("vcs")` for a compact live method index, then
`await help("vcs.edit")` (or the exact method needed) for its full schema. The generated
[public contract](references/public-contract.md). Do not guess methods or copy
request schemas into operational prose. In eval or runtime code, import
`{ contextId, vcs }` from `@workspace/runtime` and call
`vcs.status({ contextId })`, `vcs.edit(request)`, and the other methods directly.
Do not drop to raw `rpc.call("main", "vcs.*", [request])` when this client is
available. The public surface is:

```text
edit  move  copy  integrate  revert  commit  discard  importSnapshot
push  status  compare  inspect  neighbors  history  blame  readMemory
resolveRepository  readFile  listDirectory  listFiles
registerExternalDelta  supersedeExternalDelta  finalizeExternalDelta
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
  work unit; the successful import returns its event, application, work unit,
  repositories, and canonical snapshot atomically. There is no barrier change
  or post-commit evidence reconstruction to find.
- Host coordinators may expose an exact external delta as a `compare` source.
  Review it and record ordinary `integrate` decisions in the context returned
  by that coordinator. `registerExternalDelta`, `supersedeExternalDelta`, and
  `finalizeExternalDelta` are public protocol methods so userland coordinators
  can own this lifecycle; ordinary task agents must not call them. Eventual
  publication remains coordinator-owned.
- Read [checks and publication](references/checks-and-publication.md) for the
  local diagnostic loop and the protected publication gate.
- Read [typed recovery](references/typed-recovery.md) after a refusal, stale
  basis, or lost response.
- Read [worked scenarios](references/scenarios.md) for end-to-end examples.

## Finish deliberately

Before reporting success, verify the final working head is the one returned by
the last mutation, every requested integration change has a truthful decision,
move/copy returned the intended file identity semantics, and the context is
clean after commit or discard. If publication was requested, verify `push`
returned the published event and new main event.

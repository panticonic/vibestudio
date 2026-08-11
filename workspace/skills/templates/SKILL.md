---
name: templates
description: Inspect, add, update, remove, and suggest changes through the userland template composer.
---

# Workspace templates

Use this skill when a user wants to change the template relationships that
shape their workspace, check for template updates, or create a template for
others. The `@workspace-extensions/template-composer` extension is the single
owner of resolving versions, fetching content, changing template
relationships, and requesting host approval. Call it through
`extensions.invoke("@workspace-extensions/template-composer", method, args)`.
There is no host templates-service fallback.

## How to speak about templates

The service uses precise engineering terms. Translate them before speaking to
the user:

| Service term                        | Say to the user                                       |
| ----------------------------------- | ----------------------------------------------------- |
| template node, DAG, closure         | template, or “templates it brings along”              |
| pin (`ref`, commit, snapshot)       | “this exact version”                                  |
| repo path, subtree                  | a part, or its concrete name such as “the News panel” |
| incoming candidate / external delta | incoming changes                                      |
| contribution branch                 | a suggestion for the template maintainers             |
| lock or fragment                    | never mention these; say “settings from {template}”   |

In ordinary user copy, do not say _monorepo, DAG, node, pin, lock, fragment,
subtree, upstream, ref,_ or _OID_. Technical details may show the URL, tag,
commit, and content digest only in a labeled Details view.

## Rules that do not bend

- Invoke composer `add` once with the selected catalog identity or direct URL.
  Composer owns resolution, transitive acquisition, VCS merge, retained repair
  context, and the single protected-main review. Do not preflight the same
  template with `inspect` unless the user explicitly asks for a read-only
  comparison.
- Agents propose; the host approval boundary decides. A returned pending
  operation means approved composition changes are waiting for ordinary VCS
  review, not that host approval is still pending. Never show or repeat an
  internal approval reference to the user.
- Templates contribute changes; they do not own repositories. Two templates
  may contribute to the same repository, and their changes go through the
  ordinary semantic VCS merge flow.
- Never edit `meta/templates/*.yml`. Those are managed settings; direct edits
  prevent safe composition. Put a desired override in workspace settings
  through the normal reviewed configuration flow.
- Do not call an add, update, remove, or suggestion complete until the
  operation reports `applied` or the contribution is returned. A decline is
  not an error.

## Health check

1. Invoke composer `status`.
2. Invoke composer `operations`. For every returned operation, continue its
   ordinary VCS review when `state` is `reviewing`; when `state` is `repairing`,
   follow **Migration repair** below when `migration` is present; otherwise edit
   `repair.contextId` using its structured failures and invoke `resume` to
   rebuild. For other states invoke `resume`. Invoke `cancel` only when the user
   abandons an operation whose `initiator` is `user`; a `host-release`
   operation is a required shipped contract and cannot be cancelled. These
   operations are retained semantic contexts, not approval-card records;
   `resume` crosses the ordinary host gates at publication. Never describe the
   retained operation itself as an approval card.
3. Invoke composer `check` when the user asks to check, or while rendering a
   template status view. Update discovery is on-view; never schedule it.
4. Describe each result using the template’s display name and its status:
   **Up to date**, **Update available**, **Reviewing changes**, **Needs
   attention**, or **Partially updated**.

## Add a template

1. Invoke `add` with `{ source, commandId }` and a fresh `commandId`. `source`
   is `{ url, credential? }` or `{ catalogId, registryCommit?,
registrySnapshot?, refreshCatalog? }`. Pass registry coordinates supplied by
   a rendered catalog card unchanged. Use `refreshCatalog: true` only when the
   user explicitly requested a refresh. `credential` is a logical workspace
   credential name, never a concrete credential id.
2. This one invocation resolves and verifies the selected release and any
   previously unseen URL-only dependencies, stages all overlapping
   contributions through ordinary VCS, and opens one host review for the exact
   merged workspace diff. Do not explain commits, fingerprints, internal
   contexts, or contribution bookkeeping before that review.
3. If it returns `pending`, merge every `review.items[].sourceDeltaId` into
   `review.contextId` with the ordinary VCS tool's `sourceDeltaId` and
   `contextId` selectors. Invoke the `vcs` tool directly; it is not an importable
   package and must not be loaded inside an eval. Resolve only genuine conflicts semantically; clean
   and composed coordinates are drained by the merge driver. Then invoke
   `resume` with the same `operationId`. Resume requests fresh host
   approval before publishing. After `applied`, request fresh status and
   render a fresh observation. Do not alter an old catalog card to pretend it
   updated.
   An applied result may include `contextIntegration`. When it is `integrated`,
   the invoking conversation can immediately observe the publication. When it
   is `needs-merge`, merge the exact `publicationEventId` into the returned
   `contextId` with the ordinary agentic VCS workflow before claiming the new
   units are available. When it is `unavailable`, report that protected main
   was updated but do not claim the invoking context or its UI has refreshed.
   If the user abandons a user-initiated operation, invoke `cancel` with its
   `operationId`; this discards the complete isolated operation context. Never
   cancel an operation whose `initiator` is `host-release`; repair or resume it.
   If the canonical protected-main validation fails, use its structured
   diagnostics and retained operation context for ordinary agentic repair,
   then invoke `resume`. If it returns `error` with `repair`, edit that exact `repair.contextId`
   using ordinary workspace/VCS tools. Use every structured failure as repair
   feedback, then invoke `resume`. Resume rebuilds the retained result without
   reacquiring or replaying template contributions.
   If `repair.mainEventId` is present, merge that exact protected-main event
   into `repair.contextId` with ordinary VCS tools, resolve its semantic
   coordinates, and then resume. Do not abandon the contribution plan merely
   because unrelated main work landed while it was under review.
4. Do not proactively surface excluded trust/provider suggestions after an
   install. They are optional hints, not unfinished installation. Consult them
   only when the user later asks for the corresponding capability or a concrete
   runtime failure identifies the setting as relevant. Then invoke
   `decideSuggestion` directly so the host approval is the only decision.

## Adopt existing template lineage

Use adoption only when the user asserts that the workspace already descends
from an exact template release and wants Composer to begin tracking that
lineage. Invoke read-only `inspect` to resolve that explicit lineage assertion,
then invoke `adopt` with the returned pin and a fresh `commandId`.
Adoption writes the ordinary template relationship, fragments, and contribution
ledger but never merges the release's historical repository content into the
present workspace. The current repositories remain the local descendant and
are build-gated as-is. Future pulls and removals use the adopted release as the
ordinary VCS delta base. Never use adoption merely to avoid a difficult add
merge; the lineage assertion must be true and explicit.

Once committed, an unchanged installed node is complete dependency evidence.
Composition reuses its installed source selection, mutable current-workspace
layer, and descriptive contribution state without reacquiring that upstream. A
transitive add therefore acquires the new template but does not require access
to an already-installed Base. Local edits to that layer are ordinary workspace
edits and never fail an integrity comparison.

## Update a template

1. Invoke `check` with `{ alias }`, then invoke `pull` with `{ alias,
commandId })` only after the user asks to update.
2. The inspection and approval prompt describe repositories whose contribution
   sets changed. Incoming contribution deltas are merged one by one, including
   changes to repositories also contributed by other templates or edited in
   the workspace.
3. Use the normal VCS compare/merge workflow from
   [vibestudio-vcs compare and merge](../vibestudio-vcs/references/compare-and-merge.md)
   for each review. A pending operation's `review.items` names the exact part
   and external delta for that normal workflow. Confirm finalization only
   after all resulting decisions are accounted for.

## Migration repair

`operation.migration.facets` means the incoming update carries living contract
notes under `migrations/<facet>/`. `operation.migration.notes` gives the exact
incoming paths and human titles for presentation; read the bodies from the
retained workspace rather than treating the summaries as instructions. The
operation is deliberately retained in `repair.contextId` even when its merge is
conflict-free and build-green. This is the normal template update context, not
a separate migration service.

The shell's **Continue upgrade** action opens a Chat panel in that exact
`repair.contextId` with this skill named in the initial prompt. Continue in
that context. Do not create a new conversation, copy changes into another
context, or reconstruct the operation from its display details.

1. Read every incoming markdown note under the named facets in
   `repair.contextId`, including notes introduced by dependencies. Treat each
   body as the target contract and inspect the actual retained workspace before
   editing. A note that is already satisfied is a no-op. For dependent notes,
   establish the base-template contract before repairing the dependent shape.
2. Close the observed gap idempotently. Do not replay steps blindly, add a
   compatibility shim, or write an applied-note marker. Optional scripts beside
   a note are tools, not an alternate completion protocol; inspect them before
   use and handle divergent state directly.
3. Run every note's `verify` command or probe in the retained context, then run
   the normal affected build/typecheck gates. Note prose and `degraded-ok` grant
   no authority and never replace ordinary approvals. `degraded-ok` is only a
   truthful indication that ordinary use may continue while repair is pending.
4. Before `resume`, leave a concise account in the migration conversation:
   which contracts already held, what changed, why, and the verification
   evidence. Give managed edits meaningful intent and commit messages. The
   transcript and committed provenance are ordinary workspace memory; never
   create a migration ledger or correctness marker.
5. Invoke `resume` only when every applicable verification is green. If the
   contract cannot be proved, keep the operation retained, report the concrete
   mismatch and evidence to the user, and ask for help. Never land a partial
   migration silently.

For a manual “check this workspace against its current contracts” request,
read the committed `migrations/**` notes, inspect current state, and follow the
same conformance and verification loop without inventing a template operation.

## Remove or suggest changes

- Only a template named directly in workspace settings can be removed.
  A template that merely comes with another one stays connected until its
  direct parent is removed; say which direct template brings it along instead
  of offering removal. `templates.remove({ alias, commandId })` removes that
  template's contributions through ordinary VCS deltas. Other templates'
  contributions and workspace edits remain; the merge result decides the
  content.
- Invoking `suggest` with `{ alias, parts, commandId }` proposes local changes to
  the template maintainers. It does not change the workspace. On an
  idempotent retry after approval, `contribution` carries the exact branch
  and, when the provider can prove one, its URL; give that link to the user.

## Create and publish a template

Agents can author templates entirely through the composer; do not copy
workspace files with shell commands or create a temporary repository inside the
workspace.

1. Invoke `authoringParts` to discover protected-main repositories and their
   package/template contribution hints. Help the user choose parts around one
   outcome, then form one semantic intent:
   `{ name, description, parts, dependencies?: [{ url, credential? }] }`.
   Pass that intent to `inspectAuthoring`. Do not make the agent choose refs,
   commits, snapshots, or aliases for dependencies.
2. Review `requestedParts`, `requiredParts`, `dependencyParts`, and
   `overlapParts`. `dependencyParts` names repositories already supplied by the
   declared installed dependency closure. `overlapParts` is the exact
   intersection the new template will deliberately publish again; an empty list
   is the normal case. A non-empty list is allowed, but report its purpose
   plainly instead of describing those repositories as ordinary transitive
   requirements. Required
   parts are deterministic `workspace:*` or runtime dependencies; do not remove
   them.
   When the release changes a userland contract, include or refresh its
   `migrations/<template-name>` repository in the intent and follow the note
   authoring rules in the reference below.
3. Show the generated manifest and `fingerprint` in a technical details view.
   The source event binds the current workspace state. The manifest deliberately
   declares only direct URLs (plus logical credential names).
4. Ask where and how the user wants it published. Then invoke
   `publishAuthoring` with a fresh `commandId`, the same `intent`, the inspected
   `expectedFingerprint`, a version such as `1.0.0`, and
   `{ destination: { provider: "github", owner, name }, credentialId?,
`creation?: { private?, description? } }`. The owner is always explicit;
   credentials and create-time policy are not repository identity. Do not
   add resolved coordinates to the intent.
5. The invocation itself crosses the exact Git publication authority boundary.
   Confirm success only from its returned `webUrl`, `ref`, `commit`, and
   `snapshot`. The returned `templateUrl` can immediately be passed to ordinary
   `inspect` and `add` in a scratch workspace.

Publishing makes an exact installable template; it does not recommend it. A
dependency URL is a semantic compatibility expectation, not proof that the
dependency is installed, controlled by the user, or validated at a particular
release. Composition-time build and type failures are actionable feedback for
the agent to repair, not reasons to make authoring imitate a package manager.
Publishing a later version to the same destination fetches its complete
history, advances `main` normally with one new commit, and creates a new
immutable version tag. A retry never overwrites a tag: it either returns the
same exact publication, completes a missing tag after `main` was pushed, or
rejects a divergent command.
Submitting the returned coordinates to a registry is a separate reviewed Git
change. To submit one, explicitly refresh with `catalog({ refresh: true })`,
review the current catalog receipt and the publication receipt, choose the
stable id, display metadata, recommendation state, and a new
`YYYY-MM-DD.N` promotion revision, then invoke `suggestRegistryEntry` with
both receipts unchanged and, for a private release, its logical `credential`
name. The method reacquires the release and rejects stale catalog receipts, id/URL
collisions, and a changed entry without a new revision. Confirm only the
returned contribution branch; it is ready for ordinary registry review and
has not been merged or promoted. A later release uses the same method and id
with the new publication receipt. The default workspace intentionally does not
imply registry governance or silently merge a catalog change.

## Catalog ownership

The template composer owns resolution and mutation. Protected main owns the
single human review state machine. The Templates page, shell settings, and
agents invoke the same `add` method. Onboarding may recognize that an
explicit user goal needs an absent official template and hand that intent to
this workflow; it does not install templates itself or maintain a parallel
catalog. No surface implements its own catalog-to-inspection orchestration.

Catalog reads are cache-only. Invoke `catalog` with no arguments when rendering
or inspecting the current observation. Invoke `catalog` with
`[{ refresh: true }]` only for an explicit user refresh; a failed refresh may
return the last verified snapshot with `stale: true`. Keep cache-only catalog
reads separate from status projection so one observation never hides the other.
An uncached registry is returned as `null`; handle that result without
discarding a successful `status` observation. Report it as “catalog cache
unavailable”; it is not zero catalog entries and does not authorize a refresh.
A thrown error instead represents an invalid cached record or a failed explicit
refresh and should remain visible.

See [template authoring](references/template-authoring.md) and
[errors and remedies](references/errors-and-remedies.md). The machine-readable
service boundary is [public-contract.json](public-contract.json).

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

- Invoke composer `prepareAdd` before every new `add`. It is the shared
  Templates workflow used by direct UI and agents; do not reproduce catalog
  resolution or guess an exact version.
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
   edit `repair.contextId` using its structured failures and invoke `resume` to
   rebuild; otherwise invoke `resume`, or invoke `cancel` when the user abandons it. These
   operations have already crossed the host approval boundary; never describe
   them as awaiting an approval card.
3. Invoke composer `check` when the user asks to check, or while rendering a
   template status view. Update discovery is on-view; never schedule it.
4. Describe each result using the template’s display name and its status:
   **Up to date**, **Update available**, **Reviewing changes**, **Needs
   attention**, or **Partially updated**.

## Add a template

1. Invoke `prepareAdd` with `{ url, credential? }` or `{ catalogId,
refreshCatalog? }`. Use `refreshCatalog: true` only when the user explicitly
   asked to refresh the Templates surface. Onboarding may hand off an
   explicitly approved user outcome to this same workflow; it does not install
   the template itself. The composer binds a catalog id to the verified
   registry coordinates and returns `{ name, description?, inspection }`.
   `credential`, when present, is the workspace's logical credential name,
   never a concrete credential id. Explain the affected repositories and
   optional setup suggestions in plain language. Overlap is expected and is
   not a separate choice at this stage.
2. Template dependencies name URLs only. Catalog selections and previously
   unseen dependencies resolve from the reviewed registry revision; a direct
   URL is independently discovered and verified to the exact pin returned by
   the preparation.
3. Invoke `add` with `{ pin: preparation.inspection.pin, commandId }` and a fresh
   `commandId`. Pass the preparation pin
   unchanged: it is the one exact version already fetched and verified by
   `inspect`; never reconstruct it or send the locator again. The invocation
   itself crosses the host approval boundary.
4. If it returns `pending`, use its review items through the normal VCS flow,
   then invoke `resume` with the same `operationId`. Resume requests fresh host
   approval before publishing. After `applied`, request fresh status and
   render a fresh observation. Do not alter an old catalog card to pretend it
   updated.
   If the user abandons the operation, invoke `cancel` with its `operationId`;
   this discards the complete isolated operation context.
   If it returns `error` with `repair`, edit that exact `repair.contextId`
   using ordinary workspace/VCS tools. Use every structured failure as repair
   feedback, then invoke `resume`. Resume rebuilds the retained result without
   reacquiring or replaying template contributions.
   If `repair.mainEventId` is present, merge that exact protected-main event
   into `repair.contextId` with ordinary VCS tools, resolve its semantic
   coordinates, and then resume. Do not abandon the contribution plan merely
   because unrelated main work landed while it was under review.
5. Treat every returned `excludedSuggestions` item as a separate decision.
   Show its exact value, then invoke `decideSuggestion` with `{ commandId,
alias, section, decision: "accept" | "decline" }`. Acceptance writes only
   that reviewed trust/provider section to the workspace layer. Both choices
   durably record the decision so it does not reappear after reload. Never fold
   a suggestion into template installation approval.

## Adopt existing template lineage

Use adoption only when the user asserts that the workspace already descends
from an exact template release and wants Composer to begin tracking that
lineage. Invoke `prepareAdd` to acquire and review the exact release, then
invoke `adopt` with the returned pin unchanged and a fresh `commandId`.
Adoption writes the ordinary template relationship, fragments, and contribution
ledger but never merges the release's historical repository content into the
present workspace. The current repositories remain the local descendant and
are build-gated as-is. Future pulls and removals use the adopted release as the
ordinary VCS delta base. Never use adoption merely to avoid a difficult add
merge; the lineage assertion must be true and explicit.

Once committed, an unchanged installed node is complete dependency evidence.
Composition reuses its exact lock entry, generated fragment, and contribution
ledger without reacquiring that upstream. A transitive add therefore acquires
the new template but does not require access to an already-installed Base.

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
2. Review `requestedParts` and `requiredParts`. `inheritedParts` is only an
   explanatory contribution hint when a dependency happens to be installed; it
   is not validation and does not prevent explicitly selecting an overlapping
   repository. Required
   parts are deterministic `workspace:*` or runtime dependencies; do not remove
   them.
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

The template composer owns preparation and mutation. The shared template
management component owns the human review state machine. The Templates page
and shell settings embed that same component; agents invoke the same
`prepareAdd` and `add` methods directly. Onboarding may recognize that an
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

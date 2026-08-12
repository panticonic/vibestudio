---
name: templates
description: Inspect, add, adopt, update, remove, author, publish, or suggest changes to workspace templates through the template-composer extension.
---

# Workspace templates

`@workspace-extensions/template-composer` owns template resolution, verified
content acquisition, relationship changes, retained repair contexts, and host
review. Invoke it through `extensions.invoke(...)`.

Use the machine-readable [public contract](public-contract.json) for exact
methods and result discriminants. Read [template
authoring](references/template-authoring.md) for release creation and [errors
and remedies](references/errors-and-remedies.md) for failure recovery.

## User-facing language

Describe named templates, the parts they add or change, exact versions, incoming
changes, and suggestions to maintainers. Keep graph, pin, fragment, ref, and
object-ID details in an optional technical view.

## Invariants

- Invoke one composer operation per intent. Composer owns dependency resolution,
  VCS deltas, retained state, and the single protected review.
- Templates contribute changes; they don't own repositories. Overlapping
  contributions and local edits resolve through semantic VCS.
- Never edit managed template relationship files directly — use composer or the
  reviewed workspace-settings flow.
- A mutation isn't complete until its typed result confirms application or
  returns the requested contribution. A decline is a valid terminal outcome.
- Logical credential names may be stored; concrete credential IDs and secrets
  may not.

## Observe and resume

Start with `status` and `operations`. Run `check` only when the user asks or
opens a template status view — update discovery is not a background schedule.

For a retained operation, follow its state:

- `reviewing`: merge each returned source delta into the operation's exact
  review context through the ordinary [VCS
  workflow](../vibestudio-vcs/SKILL.md), then `resume`.
- `repairing`: edit the exact repair context from its structured failures, run
  focused checks, then `resume`.
- other resumable states: call `resume` and follow the next discriminant.

Cancel only when the user abandons a user-initiated operation. Product-owned
release operations must be repaired or resumed. A retained operation is not an
approval card; publication still crosses its normal review boundary.

After an applied result, honor `contextIntegration`: continue immediately after
`integrated`, merge the exact publication event after `needs-merge`, and avoid
claiming the current conversation observes it after `unavailable`.

## Add, adopt, update, and remove

For `add`, pass either the exact catalog selection or a direct URL with a fresh
command ID. Refresh the catalog only on explicit request. Never preflight the
same release unless the user asked for a read-only comparison.

Use `adopt` only when the user asserts the workspace already descends from the
inspected exact release. Adoption records lineage without importing that
release's repository state — it is not a shortcut around an add conflict.

For updates, run `check` for the selected alias, then `pull` only after the user
chooses to update. Resolve each returned delta through ordinary semantic merge
and resume when every decision is accounted for.

Only directly configured templates can be removed. If a template arrives as a
dependency, identify the direct parent instead. Removal preserves other
templates' contributions and local edits per the semantic merge.

`suggest` publishes a contribution for template maintainers without changing the
workspace. Report only the returned branch or URL.

## Contract-note repair

An operation may retain contract notes under `migrations/<facet>/` in its repair
context. Treat the note body as the target contract, not a command transcript:

1. Read every named note, including dependency notes, from the retained context.
2. Inspect the workspace and make the smallest idempotent repair. A satisfied
   note is a no-op; an optional script is a tool, not proof.
3. Run the note's verification plus affected builds or typechecks under normal
   authority.
4. Record a concise account of what held, what changed, and the evidence.
5. Resume only when every applicable contract is proved. Otherwise retain the
   operation and report the exact mismatch.

Never create applied-note markers, a separate migration ledger, a parallel
conversation, or a compatibility path.

## Author and publish

Use `authoringParts` to discover publishable protected-main parts, then
`inspectAuthoring` for one user outcome and its required dependencies. Review
the returned requested, required, dependency, and overlap parts. Include
contract notes when a release changes a userland contract.

Publish only the exact inspected fingerprint through `publishAuthoring` with an
explicit destination, version, and fresh command ID. The returned web URL, ref,
commit, snapshot, and template URL are the completion evidence. A publication
creates an installable release; registry recommendation is a separate reviewed
contribution through `suggestRegistryEntry`.

Keep the authoring workflow inside composer — never copy workspace files with a
shell command or create an auxiliary repository.

## Catalog ownership

Composer is the sole catalog and mutation owner. Onboarding may hand a selected
registry identity to this workflow but doesn't install templates itself.

Use cache-only `catalog` reads for ordinary rendering. Refresh only on explicit
user action. Preserve a stale verified snapshot as stale, distinguish an
uncached `null` from an empty catalog, and surface a failed explicit refresh
without hiding template status.

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
| orphan                              | becomes part of your workspace                        |
| contribution branch                 | a suggestion for the template maintainers             |
| lock or fragment                    | never mention these; say “settings from {template}”   |

In ordinary user copy, do not say _monorepo, DAG, node, pin, lock, fragment,
subtree, upstream, ref,_ or _OID_. Technical details may show the URL, tag,
commit, and content digest only in a labeled Details view.

## Rules that do not bend

- Invoke composer `inspect` before every `add`, including a catalog
  selection. Do not guess its exact version or what it includes.
- Agents propose; the host approval boundary decides. A returned pending
  operation means approved composition changes are waiting for ordinary VCS
  review, not that host approval is still pending. Never show or repeat an
  internal approval reference to the user.
- Never silently choose a conflict. Suggested choices are explanatory only;
  they do not authorize an agent to decide for the user.
- Never edit `meta/templates/*.yml`. Those are managed settings; direct edits
  prevent safe composition. Put a desired override in workspace settings
  through the normal reviewed configuration flow.
- Do not call an add, update, remove, or suggestion complete until the
  operation reports `applied` or the contribution is returned. A decline is
  not an error.

## Health check

1. Invoke composer `status`.
2. Invoke composer `operations`. For every returned operation, continue its
   ordinary VCS review when `state` is `reviewing`, invoke `resume` after the
   reviews are complete, or invoke `cancel` when the user abandons it. These
   operations have already crossed the host approval boundary; never describe
   them as awaiting an approval card.
3. Invoke composer `check` when the user asks to check, or while rendering a
   template status view. Update discovery is on-view; never schedule it.
4. Describe each result using the template’s display name and its status:
   **Up to date**, **Update available**, **Reviewing changes**, **Needs
   attention**, or **Partially updated**.

## Add a template

1. Invoke `inspect` with `{ url, credential? }`, `{ alias }`, or
   `{ catalogId, registryRevision }` as appropriate. A catalog selection without
   the exact revision it was rendered from is invalid. `credential`, when
   present, is the workspace's logical credential name, never a concrete
   credential id. Explain the returned parts, choices, and optional setup
   suggestions in plain language.
2. Discuss every repository conflict choice. Record each choice explicitly as
   `keep`, `take`, or `skip`; never rely on a hidden default. Template
   dependencies name URLs only, so inherited version disagreements do not
   exist: the current lock wins. Catalog selections and previously unseen
   dependencies resolve from the reviewed registry revision; a direct URL is
   independently discovered and verified to the exact pin returned by
   `inspect`.
3. Invoke `add` with `{ pin: inspection.pin, commandId, choices? }`, a fresh
   `commandId`, and any choices already discussed. Pass `inspection.pin`
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
5. Treat every returned `excludedSuggestions` item as a separate decision.
   Show its exact value, then invoke `decideSuggestion` with `{ commandId,
alias, section, decision: "accept" | "decline" }`. Acceptance writes only
   that reviewed trust/provider section to the workspace layer. Both choices
   durably record the decision so it does not reappear after reload. Never fold
   a suggestion into template installation approval.

## Update a template

1. Invoke `check` with `{ alias }`, then invoke `pull` with `{ alias,
commandId })` only after the user asks to update.
2. The inspection and approval prompt describe parts that changed. Clean
   parts apply after approval; parts changed locally must be reviewed one by
   one.
3. Use the normal VCS compare/integrate workflow from
   [vibestudio-vcs compare and integrate](../vibestudio-vcs/references/compare-and-integrate.md)
   for each review. A pending operation's `review.items` names the exact part
   and external delta for that normal workflow. Confirm finalization only
   after all resulting decisions are accounted for.

## Remove or suggest changes

- Only a template named directly in workspace settings can be removed.
  A template that merely comes with another one stays connected until its
  direct parent is removed; say which direct template brings it along instead
  of offering removal. `templates.remove({ alias, commandId })` removes the
  direct relationship, not the content. Say that affected parts stay and
  become part of the workspace, while parts still shared through another
  direct template remain connected.
- Invoking `suggest` with `{ alias, parts, commandId }` proposes local changes to
  the template maintainers. It does not change the workspace. On an
  idempotent retry after approval, `contribution` carries the exact branch
  and, when the provider can prove one, its URL; give that link to the user.

## Create and publish a template

Agents can author templates entirely through the composer; do not copy
workspace files with shell commands or create a temporary repository inside the
workspace.

1. Invoke `authoringParts` to discover protected-main repositories and their
   package/template ownership hints. Help the user choose parts around one outcome, then invoke
   `inspectAuthoring` with `{ name, description, parts, parents? }`. `parents`
   are installed template aliases whose parts should be inherited rather than
   copied. For a feature intended to sit on the official base, include the
   installed base alias. Return the selected inventory rows and complete plan
   from eval; returning the entire inventory can exceed the result limit, and
   console output alone is not a durable inspection receipt.
2. Review `requestedParts`, `requiredParts`, `inheritedParts`, and `parents`.
   Required parts are deterministic `workspace:*` or runtime dependencies; do
   not remove them. If the closure is broader than the intended outcome,
   explain the dependency and revisit the selection or code design instead of
   forcing a partial export.
3. Show the generated manifest and `fingerprint` in a technical details view.
   The receipt is bound to `mainEventId`; any intervening workspace publication
   requires a fresh inspection.
4. Ask where and how the user wants it published. Then invoke
   `publishAuthoring` with a fresh `commandId`, the complete unchanged `plan`,
   a version such as `1.0.0`, and `{ destination: { provider: "github", name,
   organization?, private?, credentialId? } }`. Do not reconstruct or trim the
   plan.
5. The invocation itself crosses the exact Git publication authority boundary.
   Confirm success only from its returned `webUrl`, `ref`, `commit`, and
   `snapshot`. The returned `templateUrl` can immediately be passed to ordinary
   `inspect` and `add` in a scratch workspace.

Publishing makes an exact installable template; it does not recommend it.
Submitting the returned coordinates to a registry is a separate reviewed Git
change. The default workspace intentionally does not imply registry governance
or silently edit a catalog.

## Catalog interactions from onboarding

The onboarding `TemplateCatalog.tsx` sends typed interactions:

```ts
{ source: "onboarding-template-catalog", kind: "template-add", targetId: "news", catalogId: "news", registryRevision: "2026-07-29.3" }
```

or, for a pasted address:

```ts
{ source: "onboarding-template-catalog", kind: "template-add", targetId: "url", url: "https://…" }
```

Route the full interaction through `executeTemplateSelection`; never infer an
operation from the button text. Then use the same inspect-and-approval flow
above.

Catalog reads are cache-only. Invoke `catalog` with no arguments when rendering
or inspecting the current observation. Invoke `catalog` with
`[{ refresh: true }]` only for an explicit user refresh; a failed refresh may
return the last verified snapshot with `stale: true`. Keep cache-only catalog
reads in their own `try`/`catch` (or catch them inside one eval) so an expected
“no verified registry is cached” result does not discard a successful `status`
observation. Report that state as “catalog cache unavailable”; it is not zero
catalog entries and does not authorize a refresh.

See [template authoring](references/template-authoring.md) and
[errors and remedies](references/errors-and-remedies.md). The machine-readable
service boundary is [public-contract.json](public-contract.json).

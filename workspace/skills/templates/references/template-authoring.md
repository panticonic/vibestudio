# Authoring a workspace template

A template is a Git repository shaped like a workspace monorepo. Its section
directories (`panels/`, `workers/`, `packages/`, `skills/`, and so on) contain
unit repositories as immediate children. `meta/template.yml` is the template
manifest: it contributes settings and declares parent templates, but is never
imported as the workspace’s own `meta` repository. `meta/vibestudio.yml` is
reserved for a composed workspace's flattened runtime configuration.

## Happy path inside the workspace sandbox

Use the template composer rather than reading host paths or assembling a Git
checkout:

```js
import { extensions } from "@workspace/runtime";

const available = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "authoringParts",
  []
);
const candidates = available.filter(({ repoPath }) =>
  ["panels/news", "workers/news"].includes(repoPath)
);
const officialBase = {
  url: "git+https://github.com/panticonic/vibestudio-workspace-base.git",
  ref: "refs/heads/main",
  commit: "38ee17d33b9f16d275b122bd4f7b71ed5ed40abb",
  snapshot: "v1-sha256:a1d5c274041470a18c491d50bdc291b11128df2c4eed1e939365b1498ed6aec2",
};
const plan = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "inspectAuthoring",
  [
    {
      name: "News",
      description: "A focused news-reading and digest workspace",
      parts: ["panels/news", "workers/news"],
      parents: [officialBase],
    },
  ]
);
return { candidates, plan };
```

The plan names optional parts available at protected main, selected parts,
automatically required parts, the full repository contribution supplied by the
verified parent closure, every closure node's exact coordinates, the generated
URL-only manifest, source event, parent closure fingerprint, and receipt
fingerprint. Review that boundary with the user. In eval, return the selected
candidate rows and complete plan as structured evidence; returning the entire
inventory can exceed the eval result limit, and printing only to the console is
not a durable inspection receipt.

Publish the unchanged receipt:

```js
const published = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "publishAuthoring",
  [
    {
      commandId: crypto.randomUUID(),
      plan,
      version: "1.0.0",
      destination: {
        provider: "github",
        owner: "panticonic",
        name: "vibestudio-template-news",
      },
      creation: {
        private: true,
      },
      credentialId: "the-explicit-connected-account",
    },
  ]
);
```

The composer re-derives the plan before requesting publication. If protected
main, the dependency closure, or manifest changed, inspect again. On success,
`published.templateUrl`, `published.ref`, `published.commit`, and
`published.snapshot` are the exact install coordinates.

The destination is a credential-free repository identity. Reuse the same
`provider`, `owner`, and `name` with a new version to publish another immutable
tag into that repository. Publication fetches the existing history and refuses
tag replacement, operation-id reuse with different inputs, and non-fast-forward
updates to `main`. Retrying the same command is safe, including after `main`
was pushed but the tag push was interrupted.

`parts` are outcome-owned unit repositories, not arbitrary directories.
Workspace package dependencies and runtime companion units are included
automatically. Use `parents` when a dependency should come from another
template instead of being copied into the new repository. Each parent is an
exact pin: `{ url, ref, commit, snapshot, credential? }`. A fresh publication
receipt supplies `url` as `templateUrl`; an installed owner returned by
`authoringParts` supplies `templatePin`. Both enter the same acquisition and
resolver path. Alias-only and moving parent declarations are rejected.

The composer reacquires every direct parent, verifies its exact commit and
snapshot, resolves its URL-declared dependency closure through the normal
registry/lock rules, and derives all inherited repositories from that verified
source. The live workspace's current ownership lock is not evidence for the
parent's contents. `meta/template.yml` remains portable: it emits only direct
parent URLs and logical credential labels, while exact pins belong to the
authoring receipt and the consuming workspace's generated lock.

## Put the right things in the repository

- Give each part its own immediate directory under a supported workspace
  section. Do not nest one unit repository inside another.
- Keep the template manifest declarative. It may declare credential-free Git
  remote URLs, branches, logical credential names, and upstreams that resolve
  against the final composed remote map.
- Parent templates belong in `templates.use` and name only their Git URL and,
  when needed, a logical credential. Exact commits and verified snapshots live
  in the generated workspace lock.
- Do not put workspace identity, concrete credential IDs or material, or
  author identity in a fragment. Those belong to the workspace owner.
- `providers` and `trust` declarations MAY appear in a fragment, and for
  integration-heavy templates they should: installation never applies them —
  the consumer-side sanitizer strips them and surfaces each one as an
  individually reviewed suggestion the installing user accepts or declines.
  Omitting them does not make a template safer; it silently deletes its
  onboarding suggestions, so the installed outcome arrives inert with no
  offered wiring. A template can declare what it wants; it can never grant or
  activate it.

## Make releases usable

Tag each published version. Promote its exact tag, commit, and verified
snapshot in the Git registry only after the template composes and builds from
a clean checkout. A template repository's moving branch never changes a
workspace by itself.

## Validate a release before promoting it

Publication is what creates the installable coordinate, so validation cannot
precede it: publish first to a **private or experimental** repository, treat
the first tags as candidates (for example `v0.x` or a `-rc` suffix), and
promote nothing until the installed result is verified. The authoring
operation build-gates its selected closure before publication, and version tags
are immutable — later validation failures require a new tag, never replacement.

An optional repository is a Vibestudio source fragment, not necessarily a
standalone npm application. Its meaningful release test is the exact
Vibestudio host plus the exact promoted base plus this optional template:

- `@workspace/*` resolves from the composed base/template source graph.
- `@vibestudio/*` resolves from platform packages supplied by that exact host
  and is skipped during external npm installation.
- ordinary third-party dependencies install normally.

Do not require a bare clone of the optional repository to pass `pnpm install`
or publish a separate npm SDK before extraction.

1. Publish privately, then start with a scratch workspace created from the
   exact promoted base and add the template
   through `templates.inspect` then `templates.add` using the exact URL, tag,
   commit, and snapshot returned by publication.
2. Check that every supplied part is assigned exactly once, and that a local
   part or an unrelated template produces a clear choice rather than a silent
   overwrite.
3. Test a template that brings in its parents, a locked older parent, and a
   conflicting pair of unrelated parents.
4. Confirm that the final workspace has one local `meta` repository and that
   settings from the template can be overridden from its top-level workspace
   configuration.
5. Test a later tagged update with a locally changed part, then verify that
   the review flow preserves the local version until the user decides.

The publication operation creates a `main` branch and an immutable version tag
at the same attributed commit. It does not modify the source workspace or add
the new repository as a workspace upstream.

Registry promotion is a later, separate review. Add the returned URL, tag,
commit, and snapshot to the registry only after clean-checkout installation and
build validation. This separation permits private, experimental, and
organization-specific templates without treating every publication as a
recommendation.

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
const plan = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "inspectAuthoring",
  [{
    name: "News",
    description: "A focused news-reading and digest workspace",
    parts: ["panels/news", "workers/news"]
  }]
);
return { candidates, plan };
```

The plan names optional parts available at protected main, selected parts,
automatically required parts, parts supplied by the parents, exact parent URLs,
the generated manifest, source event, and fingerprint. Review that boundary
with the user. In eval, return the selected candidate rows and complete plan as
structured evidence; returning the entire inventory can exceed the eval result
limit, and printing only to the console is not a durable inspection receipt.

Publish the unchanged receipt:

```js
const published = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "publishAuthoring",
  [{
    commandId: crypto.randomUUID(),
    plan,
    version: "1.0.0",
    destination: {
      provider: "github",
      name: "vibestudio-template-news",
      private: true,
      credentialId: "the-explicit-connected-account"
    }
  }]
);
```

The composer re-derives the plan before requesting publication. If protected
main, the dependency closure, or manifest changed, inspect again. On success,
`published.templateUrl`, `published.ref`, `published.commit`, and
`published.snapshot` are the exact install coordinates.

`parts` are outcome-owned unit repositories, not arbitrary directories.
Workspace package dependencies and runtime companion units are included
automatically. Use `parents` when a dependency should come from an installed
template instead of being copied into the new repository. Only pass aliases
that are present in the current installed-template inventory.

## Put the right things in the repository

- Give each part its own immediate directory under a supported workspace
  section. Do not nest one unit repository inside another.
- Keep the template manifest declarative. It may declare credential-free Git
  remote URLs, branches, logical credential names, and upstreams that resolve
  against the final composed remote map.
- Parent templates belong in `templates.use` and name only their Git URL and,
  when needed, a logical credential. Exact commits and verified snapshots live
  in the generated workspace lock.
- Do not put workspace identity, concrete credential IDs or material, author
  identity, `providers`, or `trust` in a fragment. Those belong to the
  workspace owner.

## Make releases usable

Tag each published version. Promote its exact tag, commit, and verified
snapshot in the Git registry only after the template composes and builds from
a clean checkout. A template repository's moving branch never changes a
workspace by itself.

## Validate before publishing

1. Start with a scratch workspace and add the template through
   `templates.inspect` then `templates.add`.
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

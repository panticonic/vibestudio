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
const intent = {
  name: "News",
  description: "A focused news-reading and digest workspace",
  parts: ["panels/news", "workers/news"],
  dependencies: [{ url: "git+https://github.com/panticonic/vibestudio-workspace-base.git" }],
};
const inspection = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "inspectAuthoring",
  [intent]
);
return { candidates, intent, inspection };
```

The inspection names optional parts available at protected main, selected parts,
automatically required parts, repositories supplied by the declared installed
dependency closure, and the exact selected overlap with those repositories. It
also returns the generated URL-only manifest and a compact fingerprint. An empty
`overlapParts` list is the normal focused-template result. A non-empty list is a
deliberate overlay: explain why each overlap belongs to this template. Overlap
remains supported; it must simply be visible in the publication plan.

Publish the same intent against the reviewed fingerprint:

```js
const published = await extensions.invoke(
  "@workspace-extensions/template-composer",
  "publishAuthoring",
  [
    {
      commandId: crypto.randomUUID(),
      intent,
      expectedFingerprint: inspection.fingerprint,
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

The composer builds the selected source in the current composed workspace. If
protected main, the selection, or manifest changed before the operation begins, the
fingerprint check asks the agent to inspect again. Once begun, the durable
operation retains that exact inspection so an idempotent retry cannot drift to
a newer dependency. On success,
`published.templateUrl`, `published.ref`, `published.commit`, and
`published.snapshot` are the exact install coordinates.

The destination is a credential-free repository identity. Reuse the same
`provider`, `owner`, and `name` with a new version to publish another immutable
tag into that repository. Publication fetches the existing history and refuses
tag replacement, operation-id reuse with different inputs, and non-fast-forward
updates to `main`. Retrying the same command is safe, including after `main`
was pushed but the tag push was interrupted.

`parts` are unit repositories contributing to the template's outcome, not arbitrary directories.
Workspace package dependencies and runtime companion units are included
automatically. Use `dependencies` to state a relationship to another template.
Dependencies are `{ url, credential? }`; they do not need to be installed or
controlled by the author. `authoringParts` supplies every installed template
URL that currently contributes to a repository as an explanatory hint.

The composer may use the live contribution graph to explain which repositories an
installed dependency currently supplies. That explanation is not an admission
gate. `meta/template.yml` remains portable and emits only direct dependency URLs
and logical credential labels. Exact coordinates are created by publication
and installation, not chosen during authoring.

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

Tag each published version. Promote its release coordinates in the Git registry
only after the template has been pulled into a representative workspace and
the resulting composition builds. A template repository's moving branch never
changes a workspace by itself.

## Validate a release before promoting it

Publication is what creates the installable coordinate, so validation cannot
precede it: publish first to a **private or experimental** repository, treat
the first tags as candidates (for example `v0.x` or a `-rc` suffix), and
promote nothing until the installed result is verified. The authoring
operation build-gates its selected closure before publication, and version tags
are immutable — later validation failures require a new tag, never replacement.

An optional repository is a Vibestudio source fragment, not necessarily a
standalone npm application. Its meaningful release test is a representative
Vibestudio workspace plus this optional template:

- `@workspace/*` resolves from the composed base/template source graph.
- `@vibestudio/*` resolves from platform packages supplied by that exact host
  and is skipped during external npm installation.
- ordinary third-party dependencies install normally.

Do not require a bare clone of the optional repository to pass `pnpm install`
or publish a separate npm SDK before extraction.

1. Publish privately, then add the returned template version to a scratch
   workspace through `templates.inspect` and `templates.add`.
2. Check that every supplied repository records the template's contribution.
   Add a second template that contributes to the same repository and verify
   that ordinary VCS deltas expose and merge both changes without assigning a
   winner.
3. Test an unavailable semantic dependency, an installed dependency with local
   edits, and an explicit overlapping repository selection.
4. Confirm that the final workspace has one local `meta` repository and that
   settings from the template can be overridden from its top-level workspace
   configuration.
5. Test a later tagged update with local and overlapping changes. Verify that
   merge or build failures retain one repairable context with structured
   feedback, and that resume rebuilds and publishes the repaired result.

The publication operation creates a `main` branch and an immutable version tag
at the same attributed commit. It does not modify the source workspace or add
the new repository as a workspace upstream.

The author does not need to control or republish a dependency. Local changes in
the composed workspace can help the current build, but are exported only when
their repositories are explicitly selected. Later composition may expose
incompatibilities or overlaps; build, type, and conflict diagnostics are fed
back to the agent for repair.

Registry promotion is a later, separate review. Add the returned URL, tag,
commit, and snapshot to the registry only after clean-checkout installation and
build validation. This separation permits private, experimental, and
organization-specific templates without treating every publication as a
recommendation.

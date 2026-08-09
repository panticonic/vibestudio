# Workspace template authoring from a live workspace

Status: implemented. Publication captures selected protected-main repositories;
consumer-side composition supplies ordinary VCS merge, build, and type feedback.
Publishing a standalone npm SDK or proving compatibility with a particular base
release is not a prerequisite.

## Outcome

An agent running inside the default workspace can turn a deliberate selection
of current workspace repositories into a portable, versioned template without
using a host shell or hand-writing managed composition files.

The happy path is:

1. inspect the current protected-main workspace and choose contributing parts;
2. let the composer add required workspace-package and runtime dependencies;
3. review the generated `meta/template.yml`, template
   relationships, source event, and file digest;
4. publish that immutable plan as a new Git repository and version tag;
5. verify the returned URL, tag, commit, and canonical snapshot;
6. optionally submit those exact coordinates to the registry as a separate
   reviewed contribution.

Authoring and registry promotion are deliberately separate. Publishing code
does not make it recommended, and registry review never rebuilds a different
template tree.

Dependencies are deliberately semantic rather than package-manager constraints.
The author need not install, control, republish, or prove compatibility with a
particular dependency release. Later composition supplies concrete build, type,
and conflict feedback to the self-healing agent.

## Responsibilities

- `@workspace-extensions/template-composer` owns selection, dependency closure,
  portable manifest generation, preview, and the public agent workflow.
- The manifest-selected Git interop provider owns external repository creation
  and pushing exact protected-main bytes.
- The existing template resolver remains the consumer-side authority. The
  authoring result uses the same manifest parser and canonical snapshot
  contract as installation.
- The Git registry remains an ordinary reviewed Git repository. Registry
  contribution is not a second publication or approval mechanism.

There is no staging repository inside the workspace, no filesystem export
visible to the agent, and no host-owned template factory.

## Public workflow

### `inspectAuthoring`

`authoringParts()` first exposes the exact protected-main repository inventory
with package-name and installed-template contribution hints, so an agent never has
to guess paths or source-scan the host.

Input:

```ts
{
  name: string;
  description: string;
  parts: string[];
  dependencies?: Array<{ url: string; credential?: string }>;
}
```

It returns every selectable repository, the requested parts, automatically
included dependencies, optional contribution hints for installed template layers,
portable dependency declarations, canonical manifest text, the protected
main event, and a content-addressed plan fingerprint.

Dependency closure has two sources:

- runtime declarations whose `source`, `app`, or `extension` fields refer to a
  selected unit;
- `workspace:*` dependencies in the centralized `@workspace*` package scopes,
  resolved by package name against the protected-main repository set.

`@vibestudio/*` dependencies are platform packages supplied by the host and
are not copied into authored templates.

A dependency URL is recorded whether or not that template is installed. When it
is installed, authoring reports its current contribution closure as explanatory
`inheritedParts`. Explicitly selecting an overlapping repository is allowed;
the downstream VCS composition workflow provides repairable feedback.
Missing `workspace:*` package dependencies and runtime references in the live
workspace remain concrete source errors.

### `publishAuthoring`

Input carries semantic intent and the reviewed fingerprint:

```ts
{
  commandId: string;
  intent: TemplateAuthoringIntent;
  expectedFingerprint: string;
  version: string;
  destination: {
    provider: "github";
    owner: string;
    name: string;
  };
  credentialId?: string;
  creation?: {
    private?: boolean;
    description?: string;
  };
}
```

The composer re-inspects protected main and rejects an operation whose
selection, manifest, or fingerprint changed. The Git boundary then asks for
one exact `git.publish` authority covering destination, visibility, version,
source event, parts, and manifest digest. The provider resolves the explicit
repository identity and creates it only when absent. Publication clones its
real history, emits one attributed child commit, advances `main` normally, and
creates the immutable `refs/tags/<version>` at that commit.

The result returns the clone/web URLs, canonical `git+` template URL, exact
tag, commit, snapshot digest, and exported parts. A retry with the same command
and exact destination resumes a repository-created or main-pushed partial
operation and returns the same release. The semantic operation context binds
the normalized intent before repository creation. An occupied divergent tag,
divergent command reuse, changed creation settings, or non-fast-forward main
fails closed; neither a tag nor history is overwritten.

## Portable manifest projection

The authoring projection starts from the resolved runtime manifest and keeps
only declarations relevant to the selected closure:

- source-addressed arrays are retained only when their source is selected;
- `defaultRepo`, Git remotes/upstreams, providers, trust, and host targets are
  retained only for selected repositories;
- concrete author identity is removed from upstreams;
- workspace identity, exact template pins, locks, disables,
  and registry configuration are never exported;
- template dependencies remain URL-only `templates.use` declarations.

`providers` and `trust` may be present in the source manifest so the existing
consumer-side sanitizer can expose them as individually reviewed suggestions;
installing a template still cannot grant either.

## Verification

Conventional tests cover closure, projection, stale-plan refusal, authority
binding, Git tree materialization, and result coordinates.

Headless agent tests use a fresh buildable workspace repository fixture and
ask at the user level to prepare an authoring plan. The validator requires the
agent to discover the templates skill, call `authoringParts` and
`inspectAuthoring`, select the intended package by inventory metadata, and
report the exact selected/required parts and fingerprint while proving that no
publication occurred. External Git creation remains a credentialed provider
integration test; the agentic scenario must not publish an arbitrary public
repository merely to prove discovery.

## Publication safety corrections (landed 2026-07-29)

The implementation enforces all four review findings:

1. **Pre-publication build gate.** `publishAuthoring` runs the affected build
   gate over the selected protected-main repositories before external Git
   publication. This proves the selected source builds in the authoring
   workspace. It does not claim to prove a clean install composed from the
   published child and an independently materialized parent; that remains a
   downstream candidate-release check.
2. **The idempotency binding exists before repository creation.** The composer
   records `commandId → destination + request fingerprint`
   **durably before creation**, in the operation's own record within the
   semantic operation context (the composer extension's existing operation
   record — "the operation context is the journal" applied to publication
   itself). Resume consults that record first, which closes the empty-repo
   case; the attributed trailer commit remains the remote-side recovery
   evidence for resuming across a lost local record, not the binding of first
   resort.
3. **The request fingerprint covers `creation`.** `creation.private` and
   `creation.description` are normalized into the durable intent and Git
   publication fingerprint, so a visibility-changing retry is divergent.
4. **Dependency relationships are semantic.** Agents supply URL-only
   dependency intent. Installed contributions may enrich the inspection but never
   gates it. The composer binds publication to the reviewed fingerprint and
   stores that inspection in the durable operation record for drift-free retry.
   Published templates contain only the portable URL
   declarations in `meta/template.yml`; no
   decorative authoring-provenance file is emitted.

## Registry contribution

Registry submission is a separate `suggestRegistryEntry` operation. It binds
the complete publication receipt and a non-stale verified catalog receipt,
reacquires the published exact tag (using an optional logical credential),
validates stable id/URL ownership and the proposed registry contract, records
the exact command intent before network mutation, clones the configured
registry at the reviewed commit and snapshot, and pushes a collision-safe
review branch. A changed entry requires a new human-facing promotion revision.
The operation never merges or promotes the branch and is deliberately not
bundled into `publishAuthoring`: a template can be private, unlisted,
experimental, or published to a registry with different governance.

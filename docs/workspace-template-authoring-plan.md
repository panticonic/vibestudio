# Workspace template authoring from a live workspace

Status: implemented and verified

## Outcome

An agent running inside the default workspace can turn a deliberate selection
of current workspace repositories into a portable, versioned template without
using a host shell or hand-writing managed composition files.

The happy path is:

1. inspect the current protected-main workspace and choose outcome-owned parts;
2. let the composer add required workspace-package and runtime dependencies;
3. review the exact generated `meta/template.yml`, parent-template
   relationships, source event, and file digest;
4. publish that immutable plan as a new Git repository and version tag;
5. verify the returned URL, tag, commit, and canonical snapshot;
6. optionally submit those exact coordinates to the registry as a separate
   reviewed contribution.

Authoring and registry promotion are deliberately separate. Publishing code
does not make it recommended, and registry review never rebuilds a different
template tree.

## Ownership

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
with package-name and installed-template ownership hints, so an agent never has
to guess paths or source-scan the host.

Input:

```ts
{
  name: string;
  description: string;
  parts: string[];
  parents?: WorkspaceTemplatePin[]; // exact parent release receipts
}
```

It returns every selectable repository, the requested parts, automatically
included dependencies, dependencies satisfied by the selected parents, the
portable parent declarations, canonical manifest text, the exact protected
main event, and a content-addressed plan fingerprint.

Dependency closure has two sources:

- runtime declarations whose `source`, `app`, or `extension` fields refer to a
  selected unit;
- `workspace:*` dependencies in the centralized `@workspace*` package scopes,
  resolved by package name against the protected-main repository set.

`@vibestudio/*` dependencies are platform packages supplied by the host and
are not copied into authored templates.

An exact parent may satisfy either dependency. Authoring resolves every parent
through the ordinary template resolver and binds its complete transitive
closure into the inspection receipt. A repository is never both vendored and
inherited. Missing workspace dependencies and references outside the selected
or inherited closure are errors, not warnings.

### `publishAuthoring`

Input carries the unchanged inspection receipt plus:

```ts
{
  commandId: string;
  plan: TemplateAuthoringInspection;
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

The composer re-inspects protected main and rejects any receipt whose event,
selection, manifest, or fingerprint changed. The Git boundary then asks for
one exact `git.publish` authority covering destination, visibility, version,
source event, parts, and manifest digest. The provider resolves the explicit
repository identity and creates it only when absent. Publication clones its
real history, emits one attributed child commit, advances `main` normally, and
creates the immutable `refs/tags/<version>` at that commit.

The result returns the clone/web URLs, canonical `git+` template URL, exact
tag, commit, snapshot digest, and exported parts. A retry with the same command
and exact destination resumes a repository-created or main-pushed partial
operation and returns the same release. An occupied divergent tag, divergent
command reuse, or non-fast-forward main fails closed; neither a tag nor history
is overwritten.

## Portable manifest projection

The authoring projection starts from the resolved runtime manifest and keeps
only declarations owned by the selected closure:

- source-addressed arrays are retained only when their source is selected;
- `defaultRepo`, Git remotes/upstreams, providers, trust, and host targets are
  retained only for selected repositories;
- concrete author identity is removed from upstreams;
- workspace identity, exact template pins, locks, conflict choices, disables,
  and registry configuration are never exported;
- direct exact parents become URL-only `templates.use` declarations; their
  exact closure remains bound in the authoring receipt.

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

## Registry follow-up

The first implementation ends at an exact, installable tagged repository.
Registry submission follows as a separate `suggestRegistryEntry` operation
once the official registry repository and its review CI are extracted. That
operation will clone the configured registry at the exact verified revision,
add the returned publication coordinates, and push a collision-safe review
branch. It must not be bundled into `publishAuthoring`: a template can be
private, unlisted, experimental, or published to a registry with different
governance.

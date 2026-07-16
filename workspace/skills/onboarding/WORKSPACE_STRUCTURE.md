# Workspace Directory Structure

A Vibestudio workspace is organized into source directories backed by one
semantic provenance/VCS graph. Isolated context folders materialize exact state
nodes without creating parallel histories.

## Layout

```
source/
  meta/                 ← Workspace metadata
    vibestudio.yml        ← Workspace config: init panels, external git remotes
    AGENTS.md           ← Agent system prompt
  panels/               ← Panel source code
    chat/               ← Default chat panel
    my-panel/           ← User-created panel
  packages/             ← Shared libraries
    runtime/            ← @workspace/runtime
    my-lib/
      SKILL.md          ← Repo-specific agent guidance for this package
  skills/               ← Cross-repo agent skill packages
    onboarding/         ← Workspace-wide onboarding skill and setup references
      SKILL.md
      ActionBar.tsx
    sandbox/            ← Sandbox execution skill
    workspace-dev/           ← Workspace development skill
  workers/              ← Workerd Durable Object source
    agent-worker/       ← Default AI chat worker
  apps/                 ← Trusted workspace apps
    shell/              ← @workspace-apps/shell (Electron shell target)
    mobile/             ← @workspace-apps/mobile (React Native target)
    remote-cli/         ← Optional terminal app target shape
  extensions/           ← Trusted Node extension units
    shell/              ← @workspace-extensions/shell
  about/                ← Built-in about/help pages
  templates/            ← Panel/worker scaffolding templates
  projects/             ← Plain editable repos, not runtime units
state/
  .context-projections/
    v5/                 ← Current-epoch disposable context projections
  git-checkouts/        ← Operational Git interchange; never workspace source
  build-sources/        ← Disposable exact semantic/CAS build projections
  .databases/           ← workerd Durable Object SQL state
```

## The meta/ Directory

`meta/` contains workspace-level configuration that agents need access to:

- **vibestudio.yml** — Workspace configuration (initial panels and external git remotes). Read by the server at startup; agents can read it via `workspace.getConfig()`.
- **AGENTS.md** — The system prompt injected into every agent session. Loaded by the resource loader at agent startup. Agents can also read it directly from `meta/AGENTS.md` in their context folder.

Workspace-wide onboarding lives in `skills/onboarding/` because it describes the
whole workspace rather than the `meta/` config repo itself.

Like every other source directory, `meta/` participates in the workspace-wide
semantic VCS. This means:

- It is readable from any context (materialized into the context folder on demand)
- Agents can author local applications and commit their complete context chain
- Publishing the committed workspace event triggers affected rebuilds and
  config reloads
- External Git upstreams are operationally materialized below
  `state/git-checkouts/`, never in workspace source. Startup asks the configured
  provider's `upstreamStatus` and imports only `not-materialized` rows as
  unpublished semantic candidates. Prefer `git.setSharedRemote(path, remote)`
  for targeted approval instead of editing an operational checkout by hand. See
  [EXTERNAL_GIT_PROJECTS.md](EXTERNAL_GIT_PROJECTS.md) for config shape,
  approvals, branch declarations, and private repo retry behavior.

## Context Folders

When a panel or agent session starts, it gets a **context folder** — an isolated
materialization of one context's working state. Each context has one committed
event and an exact event/application working head. The disk tree is a
disposable projection; semantic history lives only in the context graph.

Managed edits author changes and append local applications. Comparison and
integration account for incoming changes in small local decisions; commit
consumes the complete local chain. Run explicit checks against the context for
advisory confidence. Protected publication validates semantic ancestry and
integration, obtains approval, and atomically advances `main`; builds react as
separate projections. Read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) before operating on source.

Use `ref: "ctx:<contextId>"` only when intentionally building/testing code from
that moving context selector. `contextId` alone selects runtime state/files, not
code provenance. Content-only build selectors are valid for rendering and
builds but cannot be used as semantic ancestry or mutation authority.

## Trusted Apps And Extensions

Apps and extensions use flat source paths. A package named
`@workspace-apps/foo` lives at `apps/foo`; a package named
`@workspace-extensions/bar` lives at `extensions/bar`. Do not add package
scope segments to the filesystem path.

Workspace app targets are:

- `electron` — browser/Electron shell surfaces.
- `react-native` — mobile workspace app bundles.
- `terminal` — supervised Node CLI/client processes for terminal-client style
  tooling.

Capabilities are explicit in `package.json`. User and device invitations are
account operations on the typed `hubControl` service, not app capabilities.

For the full trust and client-auth model, see
`docs/trusted-workspace-units.md` in the Vibestudio source checkout.

For authoring apps, target contracts, capabilities, mobile bootstrap, and
terminal-client guidance, read `skills/appdev/SKILL.md`.

## Plain Projects

`projects/` is for repositories that should be editable in the workspace but
are not themselves panels, workers, skills, templates, or packages consumed by
the workspace build system. Examples include upstream application checkouts,
third-party libraries, or larger patch branches an agent is preparing.

Plain projects are still external Git-backed projects when imported that way:

- They appear as shared semantic workspace source only after the exact import
  candidate is integrated, committed, and published. A host clone by itself is
  an interchange artifact, not a workspace-state transition.
- Once published, they are readable from contexts through the ordinary semantic
  state/materialization path.
- Shared remotes declared under `git.remotes.projects.<repo>.<remoteName>` are
  configured in the operational checkout under `state/git-checkouts/`. Use
  object declarations with `url` and `branch` when a workspace project must
  clone a non-default branch.
- `git.importProject({ path: "projects/name", remote })` coordinates remote
  configuration/clone and crosses into the semantic graph through one explicit
  `vcs.importSnapshot` work unit. It returns a committed candidate context and
  event without advancing protected `main`. Later pulls use the same exact
  snapshot import for that stable repository identity; each import authors
  ordinary changes and follows the same incremental integration path.
- Startup imports only configured upstreams whose provider status is
  `not-materialized`. Other states are skipped as `already-materialized`;
  `git.completeWorkspaceDependencies()` uses the same provider-observed rule as
  an explicit retry/backfill. Both produce candidates, never an import-only
  publication.
- Build V2 reads the published or candidate semantic state through the CAS. It
  never builds from the operational Git checkout.
- They are not launchable runtime units and do not become `@workspace/*`
  packages.

For branch-aware declarations, import approvals, startup auto-import, and
credentialed private repo retries, see
[EXTERNAL_GIT_PROJECTS.md](EXTERNAL_GIT_PROJECTS.md).

## Template vs Live Workspace

The `workspace/` directory in the Vibestudio source repo is a **template**, never used directly as a live workspace. When a workspace is created:

1. Source directories are copied from the template into `~/.config/vibestudio/workspaces/{name}/source/`
2. Source directories are admitted by exact `vcs.importSnapshot` work units
   with explicit repository/file identities, one external snapshot tuple per
   source, and ordinary repository/file changes
3. State directories are scaffolded fresh

In dev mode (`pnpm dev`), an ephemeral workspace is created from the template
each run. Workspace events published to `main` in that generated workspace
are mirrored back into the checked-in `workspace/` template, so accepted source
changes made during a dev session persist into the source checkout.

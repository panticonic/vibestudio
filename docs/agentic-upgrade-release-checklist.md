# Pre-release coordinated-cut checklist

Use this checklist for any pre-release host/workspace ABI or shared template
format change. It enforces the clean-cut policy in
`docs/agentic-upgrade-migrations-plan.md`; it is not a migration checklist.

## Scope decision

- Does the change alter only current product behavior, with no host/workspace
  ABI or persisted internal format change? If yes, use the ordinary exact build
  and publication flow.
- If it changes the ABI or an internal format, has one new exact `systemEpoch`
  been chosen for the complete cut?
- Are all affected host, Base, optional-template, registry, and controlled
  workspace owners listed?
- Has any user-level data worth preserving been identified for explicit product
  export before destructive recreation?

## Current-only implementation

- Is there exactly one parser and one writer for the target format?
- Were old fields, parsers, writers, fixtures, fallback routes, and generated
  artifacts deleted rather than deprecated?
- Does representative old state fail with an unsupported-generation error
  before userland starts?
- Is there no structural old-state reader, converter, migration note, rescue
  harness, maintenance admission, version range, or compatibility flag?
- Are persistent stores limited to empty initialization plus exact
  current-version/current-shape validation, with no ordered migration chain,
  ledger, production baseline, or retained migration fixture?
- Do current-generation retries recover only exact interrupted effects rather
  than reinterpret old state?

## Base and official templates

- Does Base carry the chosen exact epoch and pass root inspection, canonical
  flattening, standalone Build V2, and the exact host/Base pair checks?
- Were Examples, News, Spectrolite, and Google Workspace republished at the
  same epoch and composed against the exact Base candidate?
- Does registry CI reject every mixed-epoch set?
- Does one reviewed registry snapshot promote the complete new set and expose
  no old-generation entry?
- Does the Base release artifact contain only the exact current Base pin—no
  source, system notes, migration declarations, or compatibility ranges?

## Destructive fleet cut

- Is there an exact inventory of controlled instances to recreate?
- Were deliberate user-level exports completed and verified before deletion?
- Are instances stopped and removed through their normal scoped lifecycle
  ownership, never by a broad filesystem or process deletion?
- Are the host, Base pointer, and registry deployed as one generation?
- Was every managed workspace freshly created from the exact external Base?
- Were desired optional templates installed from the new registry and any
  retained product data imported through current APIs?

## Evidence

- Exact host commit, Base pin/snapshot, optional-template pins, registry
  snapshot, epoch, and pair digest are recorded.
- Host packages and Electron artifacts contain no bundled Base fallback.
- A decoy ambient `workspace/` cannot affect build or startup.
- Current fresh-creation, current template-install, and owned development-child
  tests pass.
- Old-state tests prove rejection, not migration.
- Source search shows no compatibility or rescue implementation left by the
  cut.

Do not promote a partial generation. Before destructive deletion, leave the
previous complete pre-release generation active. After deletion begins, finish
the new deployment and recreate; do not restore obsolete internal state into
the new host.

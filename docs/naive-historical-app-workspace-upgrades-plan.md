# Naive historical-host fallback and workspace self-upgrades

Status: implemented architecture, release-set publication pending, revised 2026-08-26

This plan supersedes the recreate-by-default direction in
`docs/agentic-upgrade-migrations-plan.md` as the intended workspace upgrade
architecture. The host and Base checkout implement it; publishing the new
epoch-0 Base/template/registry release set remains a release operation.

## Decision

Keep one runnable workspace-host build per preserved `systemEpoch`. The current
machine hub reads a tiny durable launch record before starting an existing
workspace child. A record naming the installed epoch uses the installed host;
a record naming an older epoch uses its retained host. Different workspaces may
therefore run different host generations under the same current hub.

The running workspace owns its update. Its template Composer, agents, semantic
contexts, history, build tools, and review UI acquire and reconcile a target
Base as ordinary userland work. When userland decides the workspace is ready,
it publishes the target epoch and requests a restart. The hub then starts that
workspace child with the host retained for the new epoch.

This is intentionally naive and best-effort. It is not a migration mode, a
host-authored update system, or a promise that every historical host will keep
working forever.

## Principle

The workspace can define its own next generation. The system must distinguish:

```text
Can this source be manipulated as a semantic candidate by its userland?
Can this source be activated by the currently running host?
```

Those are different questions. Today the same exact-epoch parser answers both,
which prevents a running workspace from preparing its successor.

Old host code is not required to understand a future manifest schema. A stable
envelope reader extracts only `systemEpoch`; userland understands as much of
the target source as it needs and can. Exact current-schema parsing and epoch
equality remain mandatory when a host activates a workspace as its live
runtime.

## Meaning of `systemEpoch`

`systemEpoch` remains a coarse integer compatibility generation:

> A live workspace at epoch N should run in a workspace child built for epoch
> N.

It is not a migration number, compatibility range, or package constraint.
Numeric ordering does not guarantee an upgrade path. Userland may attempt a
direct update from an old epoch to whatever target release it selects; that
update is best-effort and need not pass through every intermediate integer.

Derive the epoch directly from the application version:

```text
systemEpoch = SemVer major version
```

Thus every `0.x.x` release uses epoch 0, every `1.x.x` release uses epoch 1,
and so on. Patch and minor releases stay within one workspace-host generation;
a major release creates the next one. This deliberately treats every future
major application release as a workspace compatibility boundary, even if a
particular major release might otherwise have remained workspace-compatible.
That small amount of redundant retention is preferable to maintaining another
compatibility counter and release decision.

The build derives `WORKSPACE_SYSTEM_EPOCH` from the authoritative application
version's major component; it is not a separately edited release constant.
Release validation requires the host, Base, complete template set, registry,
and retained-host marker to carry that derived value.

The existing epoch numbers are internal pre-release debris and carry no useful
meaning. Reset the implementation baseline from epoch 62 to epoch 0. Keep epoch
0 throughout pre-release, including across breaking internal changes; SemVer
already declares the `0.x.x` line unstable, and the current test workspaces are
disposable. Do not preserve a mapping, alias, or upgrade path for any earlier
epoch number. There is no special pre-1.0 runtime rule: the same major-version
derivation applies at every version.

## Ownership

### Workspace userland owns

- selecting the target Base and target epoch;
- acquiring target template source through the verified userland registry;
- composing that source with installed templates and local changes;
- using agents to resolve semantic conflicts and repair failures;
- preparing the protected-main candidate and presenting its review;
- deciding when to publish the new epoch; and
- requesting restart after publication.

### The host owns only irreducible effects

- exact active-runtime epoch admission;
- generic acquisition, VCS, build, approval, and protected-write effects;
- retaining and starting workspace-host builds by epoch;
- committing a userland-prepared epoch transition through review bound to the
  exact protected-main publication, without reactivating it in the old child;
  and
- stopping the old child and starting the selected new one.

The host does not choose the target release, interpret the semantic changes,
write migration instructions, or repair the workspace.

## Existing template-update architecture

The current ownership direction is mostly correct and should be preserved:

- `workspace/packages/template-composer` and
  `workspace/extensions/template-composer` own resolution, composition,
  semantic operation contexts, repair, and publication.
- CLI calls reach Composer through the generic extension broker.
- The host supplies generic capabilities and enforces protected writes; it
  does not contain a second template composer.

The current `baseRelease` host service is a same-epoch convenience: it supplies
the Base pin shipped with the running host and delegates the pull to userland.
It cannot define a cross-epoch update because an old host naturally ships an
old Base pin. For epoch transitions, Composer or its workspace skill selects
the target through the verified userland registry. Do not add a new host
release planner.

Template manifest parsing already accepts an `expectedSystemEpoch` argument.
Cross-epoch userland composition supplies the selected target epoch while
examining target templates. It does not claim those templates are runnable in
the old host. The historical Composer can only understand target template
schemas compatible enough with its own parser; a future incompatible template
shape may fail and is an accepted concrete limitation, not a reason to add a
forward-compatible host parser.

## Complete workflow

```text
current hub selects workspace
          |
          v
read systemEpoch from the durable launch record
          |
          v
start installed host for the current epoch or retained host for an older epoch
          |
          v
workspace runs normally with its own userland and agents
          |
          v
userland selects target Base/epoch and prepares a semantic candidate
          |
          v
user reviews the ordinary semantic change
          |
          v
userland requests publish-epoch-transition
          |
          v
old child publishes without attempting old-host activation, then exits
          |
          v
hub rereads the launch record and starts the matching host
```

There is no maintenance workspace, migration DSL, host-authored plan, or
target-host candidate orchestrator.

## Stable envelope versus active admission

Keep three deliberately different operations:

1. **Stable envelope read** extracts only `systemEpoch` from a manifest. It does
   not reject unknown fields or claim the rest of the document is understood.
2. **Current-host structural parse** validates the complete schema understood
   by that host.
3. **Active admission** additionally requires exact epoch equality before any
   live declarations, services, routes, or runtime state are activated.

Ordinary same-epoch candidate validation continues to parse, build, and
activate exactly as today. A target-epoch semantic context may be inspected and
edited by userland to the extent its own Composer and agents understand the
target source, but the old host never claims to structurally validate or
activate it.

A cross-epoch candidate reuses the ordinary semantic diff and human review
surfaces, but it does not pass through the old host's ordinary runtime-candidate
validator: that validator answers the active-admission question and must reject
the target epoch. Userland may run every source/build check that remains useful
under the old host; the first target-host admission happens after the handoff.
This deliberate best-effort gap is preferable to inventing a target-host
orchestrator for the initial implementation.

The envelope shape—YAML containing a top-level nonnegative integer
`systemEpoch`—is the only forward-compatible workspace-source convention this
plan preserves. The matching child subsequently performs its complete
current-schema parse and active-admission validation.

## Durable launch record

The hub cannot select an epoch from `source/meta/vibestudio.yml` after normal
semantic publication. That source tree is only the initial projection;
protected main deliberately does not mirror back to it.

Add one small hub-readable file under workspace state, for example
`state/host-launch.json`:

```json
{
  "version": 1,
  "workspaceId": "ws_...",
  "systemEpoch": 2,
  "stateHash": "...",
  "publicationId": "..."
}
```

The record is a launch coordinate, not another workspace manifest. It binds
the epoch to the exact semantic state and publication that selected it. The hub
reads only this file when choosing a workspace host; it does not open
epoch-specific semantic VCS storage.

Fresh creation is the sole launch-record exception because no semantic
publication exists yet. Unify every creation entry point behind one path. The
hub records a pending creation intent containing the workspace identity and
exact root-template pin, but it does not create the workspace directory. It
then launches the installed current-host child and passes that intent. The
child's existing `--init` path atomically creates the directory and creation
descriptor, admits the new workspace, completes initial semantic publication,
writes the first launch record, and asks the hub to clear the creation intent.

Use this path for explicit UI/CLI creation, first default-workspace bootstrap,
and ephemeral development workspaces. Remove the hub-side path that scaffolds a
directory before starting the child; there is one owner and one disk shape for
all pre-admission workspaces.

A missing launch record is accepted only when the catalog carries its matching
pending creation intent. The child initializer either atomically creates an
absent directory or resumes a directory carrying the exact matching creation
descriptor. A catalog entry with neither a launch record nor a creation intent
is an error. A malformed record is always an error and never falls back to the
installed host. Because the epoch-0 baseline discards all earlier test
workspaces, it needs no legacy backfill path. Source projection is never
consulted to select a host.

Before that first admission, the Electron shell keeps its Chromium data under
profile bootstrap state rather than under the not-yet-created workspace path.
This preserves the child's sole ownership of workspace directory creation.
Subsequent launches use the admitted workspace's ordinary `state/` directory.

If the first launch record exists but a crash prevented clearing the intent,
the selected child verifies the record and clearing the matching stale intent
is idempotent. The intent never authorizes recreation or replacement of an
unrecognized nonempty directory.

The disposable development workspace keeps its creation intent because its
disk checkout is intentionally rotated and recreated on later launches. It
still uses the same child initializer; the retained intent is its continuing
hub authorization, not a second bootstrap path.

The hub uses only the record's epoch for dispatch. After opening the protected
ref store, the selected child verifies the binding before activating userland:

- record workspace ID equals the hub-assigned workspace identity;
- record publication ID is the current protected-main publication and its
  recorded state hash equals the current workspace semantic state; and
- the admitted manifest epoch equals both the record epoch and the child's
  compiled epoch.

Any mismatch fails closed. The hub does not interpret epoch-specific VCS state;
the child selected for that state performs the verification.

The launch record is the first protected-publication observer and is written
atomically. Existing protected-ref recovery replays an interrupted observer, so
a crash before the record write relaunches the old host once to finish that
durable effect; a crash after it causes the hub to select the new host. No
second cross-store journal is added.

## Publishing the epoch crossing

The ordinary publication path currently reloads a newly published manifest in
the same process. That cannot publish a different epoch because the old child
would immediately reject its new active main.

Add one narrow userland-callable effect: `vcs.push` with
`epochTransition: true`. It does not accept a caller's
claim that some detachable review already occurred. One request enters the
existing serialized protected-main mutation and review gate and binds:

- the exact expected old heads;
- the exact candidate state and publication ID;
- the target epoch read from that candidate's stable envelope; and
- the transition validation policy and resulting user approval.

Within that one request it:

1. Confirm that the envelope's target epoch is available from either the
   installed current host or a retained historical host.
2. Run the existing review against the exact candidate diff and publication
   identity, using the transition-specific validation policy.
3. Publish the protected-main advance.
4. Atomically replace the durable launch record with the committed state hash,
   publication ID, and target epoch.
5. Fence all remaining old-host config reload/reconciliation observers.
6. Terminate with the explicit handoff exit status.
7. Let the hub reread the launch record and start the matching host.

If publication fails before protected main commits, the old child continues on
its old main. Once protected main commits,
the old child never clears the fence or resumes reconciliation, even if launch
record publication or intentional exit subsequently fails. It exits or is
recovered through the protected observer. If the new host fails
to start, the failure is shown and the workspace remains at its newly published
semantic main without further mutation or deletion. Automatic recovery and
rollback are outside this plan.

This effect is a process-lifecycle boundary, not a host-owned migration. All
semantic authority and target selection remain in userland.

## Per-workspace historical host selection

Do not relaunch the whole Electron application when one workspace has an older
epoch. The current hub already supervises one child per workspace; extend that
spawn point to select the child entry and app root by workspace epoch.

Other workspace children continue running. This makes two workspaces at
different epochs possible without competing machine hubs or identity writers.

Historical children initially receive the same hub environment and profile
relationships used today. An old child's hub handshake, identity projection,
native dependency, or RPC assumptions may eventually be incompatible with the
current hub. That is an accepted pre-release limitation. Do not redesign the
hub/child protocol or identity system speculatively for this plan; preserve
compatibility carefully and repair concrete failures when they occur.

## Deliberately naive retained builds

The installed application is the workspace-host launch set for the current
epoch. `host-versions/` contains only historical epochs:

```text
installed application  # current epoch 3
host-versions/
  1/
  2/
```

Each directory contains the complete workspace-child launch set already
defined by the packaged server runtime: server entry, app root resources,
required native dependencies, and a small marker recording its epoch and
application version. There is no content-addressed runtime protocol.

Historical publication is a basic filesystem transaction implemented by
`scripts/historical-host-snapshot.mjs`:

1. Build or copy the complete launch set into a sibling staging directory.
2. Verify the copied executable, server entry, and app root in staging.
3. Write the marker last.
4. Rename staging to `host-versions/<epoch>/`.

A failed copy leaves no visible retained version. A complete directory for a
different epoch is never overwritten under the wrong name.

Ordinary updates within one epoch replace only the installed host. Immediately
before installing the first release of a new epoch, publish the
final compatible patch of the outgoing installed host to
`host-versions/<outgoing-epoch>/`. Source development gets an explicit snapshot
command that performs the same publication before its checkout advances to a
new epoch. Retained versions never point back into the mutable checkout.

Initially there is no automatic download and no automatic garbage collection.
If a required epoch is missing, Vibestudio reports the missing directory and
leaves the workspace untouched.

## Coordinated epoch release set

An epoch is declared by the complete installable template set, not only by the
host constant. Resetting or advancing it therefore requires one coordinated
release cut of every artifact intended to compose together:

- the host `WORKSPACE_SYSTEM_EPOCH`;
- Base's `meta/template.yml` and `meta/vibestudio.yml`;
- every template repository represented in the release registry;
- the template registry's declared epoch and promoted immutable pins; and
- the host's exact Base release pointer.

For the epoch-0 reset, inventory the registry and republish Base and every
listed template at epoch 0. Today that includes Examples, News, Spectrolite,
and Google Workspace as named by the existing release checklist. Validate each
template against the exact epoch-0 Base candidate, then promote one registry
revision containing only that coherent set. Do not rewrite old tags or commits
in place.

This is release coordination, not workspace migration logic. Vibestudio owns
the complete pre-release template set, so the reset is complete only when every
registry template has been republished and the promoted registry contains no
prior-epoch entry.

## Accepted limitations

- Historical hosts may fail against newer operating systems, shared profile
  state, native dependencies, hub contracts, or external services.
- Direct updates across several epoch numbers are best-effort.
- The old host does not validate target-host runtime behavior before crossing.
- A bad published transition may require manual repair or restoration from
  semantic history.
- A machine failure that corrupts both protected-ref recovery evidence and the
  launch record may require manual repair.
- Historical builds receive no automatic download or indefinite security
  support in the first implementation.

These limitations are preferable to guaranteeing destruction of every old
workspace. They are not invitations to build a compatibility platform now.

## Implementation work

### WP1. Separate the stable envelope from active admission

1. Add the stable reader for only the top-level integer `systemEpoch`.
2. Keep complete structural parsing strict to the schema understood by the
   running host.
3. Apply exact equality at active workspace admission.
4. Allow userland semantic candidate tooling to name a target epoch explicitly
   without asking the old host to parse the full target manifest.
5. Keep target-epoch source unavailable to live old-host declarations.

Exit: an old workspace can inspect and edit a target-epoch candidate without
the old host claiming to understand or activate its future schema.

### WP2. Preserve workspace-host builds by epoch

1. Define the installed host as the current-epoch launch set and
   `host-versions/<epoch>/` as historical-only storage.
2. Record application SemVer and its derived major-version epoch in each marker
   and reject a marker where they disagree.
3. Reuse the packaged server runtime artifact inventory as the complete launch
   boundary.
4. Add staging, validation, and rename publication.
5. Before a SemVer major upgrade, publish the final outgoing
   compatible patch; add the equivalent source-development snapshot command.

Exit: the installed current host and a retained historical host can each be
started explicitly without a current-epoch directory or reads from the mutable
source checkout.

### WP3. Select the retained host per workspace child

1. Add one durable pending creation intent containing workspace identity and
   exact root-template pin.
2. Route UI/CLI, default bootstrap, and ephemeral creation through the same
   installed-host child `--init` path; remove hub-side workspace scaffolding.
3. Write the first launch record only after initial semantic publication, then
   clear the matching creation intent idempotently.
4. Permit a missing record only for a matching pending creation intent; reject
   missing or malformed records otherwise.
5. Read an existing workspace's epoch from its record before runtime
   initialization.
6. Resolve the installed launch set for the current epoch and a retained
   directory only for a historical epoch.
7. Have the selected child verify workspace identity, head publication, semantic
   state hash, manifest epoch, and compiled epoch before userland activation.
8. Spawn only that workspace child from the selected host.
9. Keep the current hub and other workspace children running.
10. Surface missing or broken historical hosts without deletion or relaunch
   loops.

Exit: two workspaces at different epochs can run as separate children of the
same hub when their retained hosts remain compatible with it.

### WP4. Let userland compose a target generation

1. Make the verified userland registry, not the old host's `baseRelease` pin,
   the source of cross-epoch target selection.
2. Let Composer parse target templates against the userland-selected epoch.
3. Reuse ordinary semantic contexts, agent repair, diff presentation, and
   review.
4. Do not introduce migration scripts, a host target planner, or a separate
   upgrade operation store.

Exit: the running historical workspace can prepare and review its desired
target-generation source.

### WP5. Publish and restart without old-host activation

1. Add the narrow `epochTransition: true` mode to `vcs.push`.
2. Enter the existing protected-main mutation lease and bind review to the
   exact candidate state and publication ID in the same request.
3. Read the target only through the candidate's stable epoch envelope.
4. Make launch-record replacement the first durable publication observer and
   fence later old-child reconciliation once that commit is visible.
5. After commit, exit with the hub's intentional handoff status.
6. Stop the old child and start the selected installed or retained host.
7. Reuse protected-publication observer replay for commit-to-record recovery;
   do not add a transaction journal or automatic rollback.

Exit: a workspace crosses epochs under userland direction and relaunches with
the matching host without being recreated.

### WP6. Align release policy and documentation

1. Reset the current pre-release epoch from 62 to the SemVer-derived epoch-0
   baseline and inventory every template entry in the release registry.
2. Derive the exported host epoch from the authoritative application SemVer
   major and fail build/package validation if release artifacts disagree.
3. Change both Base manifests and every listed template manifest to epoch 0,
   then publish new immutable template releases.
4. Validate those releases against the exact epoch-0 Base and promote one
   registry revision containing no prior-epoch entry.
5. Adopt the newly published Base pin in the host release artifact and cut the
   matching host build.
6. Keep epoch 0 throughout disposable-data pre-release development; recreate
   test workspaces for breaking cuts instead of spending new epochs.
7. Before releasing 1.0.0, preserve the final compatible epoch-0 host.
8. Test the workspace-owned transition mechanism with controlled fixtures; do
   not cut a real epoch merely to exercise it.
9. Continue publishing host, Base, registry, and the complete template set as
   one coherent epoch release set.
10. Replace recreate-only instructions for preserved workspaces while retaining
   explicit recreation for disposable test workspaces.

Exit: epoch release guidance treats historical launch and workspace
self-update as the normal path.

## Focused verification

- The stable envelope reader extracts a foreign epoch without interpreting the
  rest of its manifest.
- UI/CLI, default bootstrap, and ephemeral creation all persist one creation
  intent and use the same child-owned `--init` path.
- A pending creation launches on the installed host, publishes semantic main,
  writes its first launch record, and clears its intent.
- The pre-admission Electron shell does not create the workspace directory as
  a side effect of selecting its Chromium user-data path.
- Missing launch records without a matching creation intent, and all corrupt
  launch records, fail closed and never select the installed host by default.
- A pre-record initialization retry never overwrites an unrecognized nonempty
  workspace directory.
- Complete old-host structural parsing remains strict and active admission
  rejects a foreign epoch.
- Same-epoch template updates and protected-main publication remain unchanged.
- The epoch-0 release registry contains only template pins whose
  manifests declare epoch 0 and which compose against the exact epoch-0 Base.
- The host's adopted Base release pointer resolves to that same epoch-0 Base;
  no old immutable template tag or commit is rewritten.
- Userland Composer can acquire and inspect a target-epoch Base in a semantic
  context when its historical userland understands that target source.
- Ordinary publication still refuses to activate a foreign epoch in the old
  child.
- `vcs.push({ epochTransition: true })` binds expected heads, candidate state, publication
  ID, envelope epoch, review, and commit in one serialized request.
- Successful transition publication replaces the launch record with the exact
  committed semantic state before requesting restart.
- The selected child rejects a stale, tampered, wrong-workspace, or
  same-epoch-but-wrong-state launch record before activating userland.
- A crash before protected-main commit leaves the old host usable; a crash
  after commit replays the launch-record observer before ordinary activation.
- A missing target host prevents transition publication and leaves old main
  active.
- A current-epoch record uses the installed host without requiring
  `host-versions/<current-epoch>/`; a historical record uses only its retained
  directory.
- Two workspaces at different epochs can run independently when their host/hub
  contracts remain compatible.
- A failed historical child produces an actionable error without deleting or
  rewriting workspace state.
- A representative workspace updates itself, publishes its target epoch, and
  restarts under the matching retained host.

## Explicit non-goals

Do not add any of the following:

- a migration mode or maintenance runtime;
- host-authored semantic transformations;
- target-host candidate orchestration;
- automatic rollback or state conversion;
- a migration graph, ledger, or ordered migration scripts;
- content-addressed host-runtime selection;
- a compatibility solver or version ranges;
- a new hub/child, identity, credential, or native-effect architecture;
- containers or virtual machines for historical releases;
- automatic historical-host downloads; or
- a guarantee that arbitrary historical hosts remain runnable.

When a concrete retained host fails, investigate that concrete failure. Do not
expand this best-effort mechanism into speculative compatibility machinery.

## Completion criterion

An epoch mismatch no longer implies workspace recreation. The hub first runs
the workspace under its retained matching host; the workspace uses ordinary
userland and agent capabilities to define its target generation; and one
narrow publish-and-restart effect hands the already-reviewed semantic result to
the matching newer host.

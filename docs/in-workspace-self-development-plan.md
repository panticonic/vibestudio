# In-workspace Vibestudio development

## Status

Implemented 2026-07-14. This document is now the architectural contract for
in-workspace Vibestudio development and the acceptance baseline for future
changes.

This document defines the architecture and migration required for Vibestudio to
develop, build, launch, and evaluate Vibestudio itself from a normal GAD
workspace context. It supersedes the removed source-checkout mirroring and
dogfood paths.

This plan consumes, but does not wait wholesale for, the runtime-foundations
refactor. Build V2 effective versions remain the identity of internal workspace
units. A self-build is different: `projects/vibestudio` is a content project and
is identified by its resolved repository state plus an explicit build recipe,
builder, target, runtime, and declared environment. Both use the same
lower-level content-addressed execution-snapshot primitive defined in section
6.1. R3 capability principals must exist before the public `devHost` service is
enabled, and R4 channel ownership must exist before the Claude cutover; Git
Bridge, direct-client, toolchain, and synchronizer work do not wait for the
unrelated portions of that refactor.

The central decision is:

> The GAD repository at `projects/vibestudio` is the development source of
> truth. A Git checkout is an upstream interchange artifact, a context folder
> is a projection, and build output is disposable scratch. None of those is a
> second source of truth.

## 1. Desired end state

An agent or human working in a Vibestudio context can:

1. Edit `projects/vibestudio` through normal context-scoped VCS operations,
   including uncommitted working edits.
2. Launch a client built from that exact working state against either:
   - the current server; or
   - a new, isolated server built from the same state.
3. Interact with the dev-built host through typed RPC, including running
   `eval.run`, without spawning the CLI as a subprocess.
4. Launch Claude Code as a first-class subagent in a writable, synchronized
   working tree for the same context.
5. Use the exact `vibestudio` CLI belonging to the host in every host-created
   shell, Claude process, and trusted extension, independent of ambient
   `PATH` or Node installation.
6. Publish and consume the monorepo through the normal Git Bridge without
   turning Git into a parallel workspace VCS.

The topology is:

```text
external Git remote
        |
        | Git Bridge import/export/pull/push
        v
GAD protected main: projects/vibestudio
        |
        | context base + commits + uncommitted edit ops
        v
GAD context working state
        |
        +---------------------+-----------------------+
        |                     |                       |
        v                     v                       v
context projection     writable tool mirror    CAS execution snapshot
read-only scratch      Claude/local editors     exact private build input
                                                      |
                                   +-----------------+----------------+
                                   |                                  |
                                   v                                  v
                          dev-built Electron                  dev-built isolated hub
                          current or new host                        |
                                                                     v
current userland -> devHost service -> dev-host extension -> direct RPC -> eval.run
```

## 2. Goals

### 2.1 Product goals

- Make self-development an ordinary workspace workflow rather than a special
  bootstrap mode.
- Build from the caller's context, including uncommitted edit operations.
- Make the two useful launch targets explicit:
  - `current-host-client`: rebuild the Electron client and pair it to the
    already-running host.
  - `isolated-host`: build and run a new hub, optionally with its Electron
    client.
- Give agents a typed `devHost` runtime surface for launch, status, logs,
  rebuild, stop, and eval.
- Make Claude Code discoverable, health-checked, correctly materialized, and
  safe to launch as `agentKind: "claude-code"`.
- Have one host-owned command distribution mechanism and one user-facing CLI.

### 2.2 Engineering goals

- Preserve one canonical RPC protocol and the existing authentication model.
- Preserve the host/extension trust boundary: policy and identity stay in the
  host; local process execution stays in a trusted extension.
- Make every build and launch attributable to a context state hash, recipe,
  builder, target, runtime, declared environment, and host build identity.
- Fail before changing state when source fidelity cannot be guaranteed.
- Make cleanup precise: only owned processes, credentials, sockets, ready
  files, and scratch directories may be removed.
- Support Linux, macOS, and Windows without a Unix-only command-injection
  special case.

## 3. Non-goals

- GAD will not model the Git commit DAG. Git history remains in the Git Bridge
  interchange checkout; GAD imports the selected branch tree with provenance.
- Context projections will not become Git worktrees and will not contain
  `.git`.
- `projects/vibestudio` will not become a Build V2 unit. It is a content
  project whose own build system is invoked by the dev-host extension through
  the shared content-addressed execution-snapshot contract.
- The dev-host extension will not expose arbitrary command execution as a
  public method.
- The child hub's admin token will not become a general RPC credential.
- The old host-checkout mirror will not be repaired or retained as a fallback.
- A permanent `snug` compatibility binary will not coexist with
  `vibestudio terminal`.

## 4. Architectural invariants

### I1. GAD is authoritative

The source state passed to a build is the state resolved from the invoking
context. A checkout, mirror, or disk folder may be projected from that state
but may never silently replace it.

The build never reads the shared context projection. The resolved state is
materialized directly from CAS into a launch-owned execution root. That root is
private and disposable; edits arriving while the build runs cannot change its
input.

### I2. Dirty work is a first-class input

An uncommitted edit is a GAD edit operation, not an untracked disk mutation.
The launch record must name the resolved state hash and whether the source has
uncommitted edits.

### I3. Git Bridge is only the upstream boundary

Git Bridge imports remote branch content into protected main and exports GAD
states to Git. The dev runner never builds from the Git Bridge checkout.

### I4. External tools use a synchronized writable tree

A raw process such as Claude Code cannot edit a read-only projection and hope
that disk drift becomes workspace state. Its working tree must translate local
changes into `vcs.edit` operations and apply inbound GAD states without echo
loops.

### I5. Every host owns its CLI

Every host publishes one exact, versioned `vibestudio` launcher together with
an exact host-owned JavaScript runtime and prepends the launcher to the
environment of processes it creates. A child dev host publishes its own
launcher and runtime. Ambient global installations of either `vibestudio` or
Node are irrelevant.

### I6. One CLI, explicit transports

`vibestudio` is the only host-provided command. Normal commands use canonical
host RPC. `vibestudio terminal` uses an explicitly selected session-local
terminal-control endpoint. It never guesses a transport or silently falls back
between them.

### I7. Normal device authentication

A dev-built hub is accessed using an ordinary paired device credential. Its
management/admin token is held by the supervisor, never accepted as a general
RPC credential, returned through `devHost`, or deliberately delegated to a
child. Current-host client launches use a normal invite minted on behalf of the
authenticated caller. The same-user OS threat boundary is stated in I11.

### I8. Explicit commit points and exact recovery

Every multi-step operation declares a durable commit point. Before that point,
it may compensate only writes still proven to be owned by that operation,
using compare-and-restore against captured pre-state. It may not overwrite a
concurrent change merely to recreate an old snapshot. After the commit point,
the operation is resumed idempotently to completion; it is never presented as
rolled back while an authoritative effect remains. Failures that cannot be
proved safe to compensate become an explicit `requires-repair` state carrying
both the original and recovery errors.

### I9. Unsupported source is rejected

If a tracked source entry cannot be represented faithfully, import fails with
an actionable error. Symlinks, gitlinks, sockets, or other unsupported entries
are never silently omitted.

### I10. No hidden execution

Importing a repository records content and configuration; it does not install
dependencies or execute project code. Bootstrap/build/run require a separate,
visible approval boundary. By default the approval names one exact execution
input hash. A grant to execute future states is a distinct, explicit,
time-bounded watch grant that names the context, repository, allowed recipes,
and risk that future source changes may alter executable scripts.

### I11. No ambient authority delegation

A trusted extension credential authorizes the extension, not arbitrary native
processes it starts. Bootstrap scripts, build commands, dev hubs, Electron,
Claude Code, and other tools receive an allowlisted environment and only the
minimum explicit credential intended for that child. Parent extension RPC
tokens, storage paths, inspector endpoints, management tokens, and unrelated
session capabilities are never inherited accidentally.

An isolated config directory is lifecycle and collision isolation, not an OS
security sandbox. Approved development code runs with the local user's OS
authority unless a separately specified platform sandbox is active; the UI and
status must say so rather than implying containment that does not exist.

### I12. Candidate promotion preserves the last good generation

A rebuild produces a candidate generation. The active generation is not
relabelled or irreversibly destroyed until the candidate has passed artifact
validation, startup, identity verification, pairing, and required probes. A
failure in any candidate phase leaves the last-good artifact and durable state
recoverable and reports which generation remains active.

## 5. Current-state assessment

### 5.1 What is already correct

- `projects/` is a supported Git import parent.
- `projects/*` is intentionally excluded from Build V2 package discovery.
- Git import uses the configured provider, records a remote/upstream with
  `autoPush: false`, imports content into GAD, advances protected main, and
  adopts the repository into the invoking context.
- Context state resolution includes committed state plus uncommitted edit
  operations.
- `ctx.fs.ensureMaterialized(scope)` can project a requested repository.
- The existing CLI RPC client already supports HTTP, WebSocket, WebRTC, device
  refresh, agent tokens, push, and recovery.
- Hub startup already has a strict ready payload and loopback pairing flow.
- Claude Code already has linked-agent entities, agent-bound credentials,
  channel lifecycle, permission UI, and
  `spawn_subagent({ agentKind: "claude-code" })`.
- The shell extension already proves that a host-owned command can be injected:
  it generates `snug`, prepends its temporary bin directory, and binds each
  shell session to a private socket.

### 5.2 Gaps that block the end state

#### Git Bridge

1. Failure to discover the remote default branch is swallowed. A branchless
   declaration may later behave as though `main` were authoritative.
2. Clone-failure compensation removes declarations instead of restoring the
   exact prior workspace configuration.
3. A failure after protected-main publication can be reported like an ordinary
   clone/import failure even though the authoritative import already committed.
4. Checkout scanning silently ignores filesystem entries outside the GAD file
   model.
5. Default-branch behavior lacks focused failure-mode coverage.

#### Context working trees

1. `ensureContextFolder` intentionally creates a sparse directory and marker;
   it does not materialize repositories.
2. Out-of-band writes to the server projection are not GAD edits.
3. `vibestudio context mirror --watch` is the right conceptual adapter, but
   its current v1 implementation needs production hardening before it becomes
   the working tree for Claude Code.
4. Current writeback omits the available `baseStateHash` guard and has no
   durable client edit ID, so a stale or lost-response edit is unsafe.

#### Toolchain and shell command

1. The root package declares `vibestudio`, but the extension host inherits
   ambient `PATH` without injecting that binary.
2. Claude profiles invoke the literal string `vibestudio`, so they can fail
   or resolve a different installation.
3. `snug` has a separate generated executable and independent protocol
   version despite being a Vibestudio command surface.
4. The current `snug` injection is disabled on Windows.
5. The packaged CLI assumes an ambient JavaScript runtime rather than publishing
   the exact runtime with the host toolchain.
6. Trusted extensions can pass their complete ambient environment—including
   provider credentials—to native children unless each caller sanitizes it.

#### Dev runtime

1. No extension owns building and supervising a host from a GAD context.
2. The old dogfood script explicitly ignores mirror events; it cannot
   self-update the host it started.
3. Existing documentation still describes the dead mirror behavior.
4. There is no durable launch identity, lifecycle API, or source-state
   provenance for a dev-built host.
5. There is no private CAS snapshot/build-input identity, state-bound execution
   approval, or active-versus-candidate promotion contract.
6. Existing development supervisors inherit broad ambient environments and do
   not isolate managed Electron profiles from the ordinary desktop.

#### Direct client

1. Reusable transport and auth logic is private to `src/cli`.
2. It imports CLI output, credential-store, and command concerns.
3. Userland has no safe typed route to a child host's eval service.

#### Claude Code

1. Launch ensures only the sparse context folder, not a synchronized writable
   repository tree.
2. Plugin, MCP, hook, and skill installation have overlapping sources.
3. `VIBESTUDIO_SKILLS_DIR` has no reliable host-owned producer.
4. Activation reports healthy before validating the Claude binary, version,
   plugin, or exact Vibestudio CLI.
5. Claude currently inherits the extension process environment rather than an
   explicit attenuated child environment.
6. Coverage is mocked; no real system scenario proves launch and lifecycle.

### 5.3 Existing code map

The implementation should begin from these existing owners rather than
introducing parallel machinery:

- Git import policy and configuration:
  [`src/server/services/gitInteropService.ts`](../src/server/services/gitInteropService.ts)
- Protected config compare-and-swap writer:
  [`src/server/workspaceConfigWriter.ts`](../src/server/workspaceConfigWriter.ts)
- Git provider clone/export/import and checkout scan:
  [`workspace/extensions/git-bridge/bridge.ts`](../workspace/extensions/git-bridge/bridge.ts)
  and
  [`workspace/extensions/git-bridge/upstream.ts`](../workspace/extensions/git-bridge/upstream.ts)
- Workspace source/build taxonomy:
  [`packages/workspace-contracts/src/sourceDirs.ts`](../packages/workspace-contracts/src/sourceDirs.ts)
- Context state resolution and projection:
  [`src/server/vcsHost/workspaceVcs.ts`](../src/server/vcsHost/workspaceVcs.ts)
- Remote mirror CLI and service:
  [`src/cli/contextCommands.ts`](../src/cli/contextCommands.ts),
  [`packages/service-schemas/src/mirror.ts`](../packages/service-schemas/src/mirror.ts),
  and
  [`src/server/services/mirrorService.ts`](../src/server/services/mirrorService.ts)
- Canonical VCS edit CAS contract:
  [`packages/service-schemas/src/vcs.ts`](../packages/service-schemas/src/vcs.ts)
- Extension process environment:
  [`packages/extension-host/src/processManager.ts`](../packages/extension-host/src/processManager.ts)
- Existing terminal command injection:
  [`workspace/extensions/shell/snugServer.ts`](../workspace/extensions/shell/snugServer.ts)
- CLI transport and eval adapters:
  [`src/cli/rpcClient.ts`](../src/cli/rpcClient.ts) and
  [`src/cli/agent/evalCommand.ts`](../src/cli/agent/evalCommand.ts)
- Hub startup, readiness, and loopback pairing:
  [`src/main/hubProcessManager.ts`](../src/main/hubProcessManager.ts) and
  [`scripts/dev-webrtc-remote.mjs`](../scripts/dev-webrtc-remote.mjs)
- Current host-build fingerprint and managed desktop startup owners:
  [`scripts/host-build-fingerprint.mjs`](../scripts/host-build-fingerprint.mjs),
  [`src/main/index.ts`](../src/main/index.ts), and
  [`src/main/startupMode.ts`](../src/main/startupMode.ts)
- Current dead dogfood supervisor:
  [`scripts/start-dogfood-server.mjs`](../scripts/start-dogfood-server.mjs)
- Claude extension and launch profile:
  [`workspace/extensions/claude-code/index.ts`](../workspace/extensions/claude-code/index.ts)
  and
  [`workspace/extensions/claude-code/profile.ts`](../workspace/extensions/claude-code/profile.ts)

## 6. Component boundaries

| Component                      | Owns                                                                            | Must not own                                                          |
| ------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Git Bridge host service        | policy, config mutation, protected-main publication, context adoption           | Git subprocesses or development builds                                |
| Git Bridge extension           | clone/fetch/export/import mechanics and Git checkout                            | workspace policy or GAD head authority                                |
| Execution snapshot service     | immutable CAS materialization and execution-input identity                      | project-specific build commands or authorization                      |
| Host toolchain publisher       | exact CLI/runtime artifacts, manifest, atomic activation, environment injection | session-specific authorization                                        |
| Terminal-control server        | session binding, terminal metadata/actions, local endpoint lifecycle            | a second executable or global host auth                               |
| Direct client package          | transports, auth refresh, typed RPC, pairing primitives                         | CLI output, argument parsing, global credential storage               |
| `devHost` host service         | authorization, caller context, current-host invite, provider dispatch           | build subprocesses                                                    |
| dev-host extension             | snapshot requests, dependencies, build, supervision, child pairing, child RPC   | caller policy, ambient credential delegation, or admin-token exposure |
| Context workspace synchronizer | GAD projection, local edit writeback, inbound reconciliation                    | merge semantics or a new VCS                                          |
| Claude Code extension          | Claude process and linked-agent lifecycle                                       | duplicated plugin/skill sources or raw projection edits               |

### 6.1 Shared content-addressed execution foundation

Runtime Foundations R1/R2 must expose a primitive below Build V2 rather than
making this monorepo a Build V2 unit. The common contract is provisionally:

```ts
interface ContentSourceRef {
  repoPath: string;
  stateHash: string;
}

interface ExecutionInput {
  source: ContentSourceRef;
  recipeHash: string;
  builderBuildId: string;
  target: { platform: string; architecture: string };
  toolchain: { components: Record<string, string> };
  declaredEnvironmentHash: string;
}

interface ExecutionSnapshot {
  executionInputHash: string;
  sourceRoot: string;
  scratchRoot: string;
}
```

The concrete shared types may differ, but the semantics may not:

- `stateHash` is resolved once by the host from the verified caller context;
- the snapshot service reads that exact state from CAS and materializes it into
  a private, launch-owned root without consulting or copying the live context
  projection;
- source materialization is immutable for the lifetime of the execution;
  dependency and output writes go to a private copy-on-write layer or scratch;
- the recipe identifies the exact commands and supervisor implementation;
- the builder identity, target, every runtime/native toolchain component, and
  every allowed output-affecting environment value participate in the
  execution input hash;
- secrets and undeclared ambient environment never participate in a build and
  are never available to build commands;
- immutable artifacts and their manifests are keyed by the execution input
  hash and retained while an active, candidate, pinned, or rollback generation
  references them.

Build V2 maps a unit effective version and its dependency closure onto this
primitive. The dev-host maps the `projects/vibestudio` working state directly
onto it. An effective version alone cannot identify a platform-dependent host
artifact; Runtime Foundations R2 must therefore define artifact identity as the
content identity plus the builder/toolchain/target tuple, not claim that EV by
itself determines every artifact.

Runtime Foundations R3 is a prerequisite for exposing `devHost`. Its capability
checks must be resource-aware: a string such as `devHost.launch` is insufficient
without constraints for caller principal, workspace, context, repository,
launch ownership, and—where code execution is approved—execution input hash.
Local process delegation remains governed by I11; dispatcher capabilities do
not make inheriting a bearer token safe. R4 is used for Claude channel ownership
and membership but does not replace filesystem synchronization or process
isolation.

## 7. Git Bridge hardening

### 7.1 Definitive default branch

Import without an explicit branch must have one of two outcomes:

1. `remoteDefaultBranch` returns a concrete branch before the prepared clone;
   or
2. the provider clones remote HEAD only into operation-owned scratch and
   returns the concrete checked-out symbolic branch as part of the prepared
   candidate.

If neither produces a concrete branch, import fails before workspace
configuration, protected main, an authoritative checkout, or context state
changes. The resolved branch is persisted during configuration before the
protected-main commit point.

There is no `main` fallback. Empty repositories need a separate explicit
contract: either the caller names the initial branch or the provider reports
that the remote is empty and the import is rejected until an initial branch
exists. Do not infer a branch from local Git defaults.

The second form may remove a separate discovery round trip, but it may not
create a provisional branchless configuration or publish content before the
host has recorded the concrete branch in the operation journal.

### 7.2 Durable import transaction

Git import crosses disk scratch, workspace configuration, a repository's
protected main, bridge bookkeeping, and context adoption. Pretending those
systems can all be rolled back after publication is unsafe. Import is a durable,
idempotent operation with a host-minted operation ID (or a caller idempotency
key scoped to caller/workspace/repository) and these phases:

```text
requested -> preparing -> prepared -> configuring -> committing
          -> committed -> adopting -> complete
Any pre-commit phase -> aborted | requires-repair
committing -> commit-outcome-unknown -> committed | aborted | requires-repair
Any post-commit phase -> committed-incomplete -> adopting -> complete
```

Preparation is side-effect-free with respect to authoritative workspace state:

1. clone into an operation-owned temporary checkout;
2. resolve and record the exact branch and commit SHA;
3. run the complete fidelity preflight from Git objects;
4. mirror candidate blobs/trees and stage the candidate on an
   operation-addressed non-main lineage;
5. return a prepared candidate identity without advancing protected main,
   changing workspace configuration, or adopting a context.

Before configuration, persist the operation journal and capture only the
relevant remote/upstream field preimages plus the exact values this operation
will write. Serialize conflicting imports for the same repository. Apply the
narrow configuration mutation through the normal compare-and-swap writer.

Advancing the imported repository's protected main is the commit point. Before
that point, failure removes operation-owned scratch and restores a configuration
field only if its current value still equals this operation's write. A
concurrent edit is never overwritten; a failed compare-and-restore produces
`requires-repair` with both errors and the observed configuration identity.
Immediately before publication, revalidate that the configured remote/upstream
still equals the operation's expected write.

The protected-main publication is idempotent by import operation ID, and the
GAD writer records that ID in its write-ahead intent/provenance. A timeout or
lost response enters `commit-outcome-unknown`; recovery queries the writer by
operation ID before doing anything else. It may compensate configuration only
after proving publication did not commit.

After protected main advances, the import is committed. Checkout-map writes,
export markers, configuration notification, source-tree refresh, and context
adoption are idempotent finalization. Their failure must not delete the checkout,
remove configuration, or claim the project main was rolled back. The journal
records `committed-incomplete`; retrying the same operation ID resumes
finalization. Startup/doctor also discovers and resumes or reports incomplete
imports.

Bridge-private marker writes after the commit point must either be
reconstructible from protected-main provenance and the prepared Git identity
or leave an explicit repair record. A return from `importProject` means
`complete`, not merely that protected main advanced.

### 7.3 Source fidelity preflight

The imported content is the selected commit's Git tree, not a filesystem walk.
Enumerate tracked entries from Git objects at the resolved commit and read blobs
from those objects. This removes checkout races and makes untracked scratch
irrelevant. Reject at least:

- symbolic links until GAD has an explicit link model;
- gitlinks/submodules;
- tracked entries whose type or mode cannot be represented;
- paths that collide under the portable path rules of any supported target;
- platform-reserved names or paths rejected by workspace path normalization.

Every tracked regular or executable file is imported regardless of its name.
A tracked `.env`, log, editor file, dependency, or generated artifact is still
part of the Git tree and may not be silently excluded. `.git` is not a tree
entry; untracked checkout files are absent because import never enumerates the
worktree. If the GAD file model or path policy cannot represent a tracked path,
preflight rejects the repository instead of applying a snapshot ignore rule.

The error must enumerate offending paths and entry types. The import must not
publish a partial tree.

### 7.4 Import result

The returned result should identify:

- durable import operation ID and terminal phase;
- normalized repository path;
- remote name and URL identity;
- resolved upstream branch;
- imported GAD state hash;
- Git commit SHA used as provenance;
- whether protected main changed;
- adopted context ID.

An incomplete committed operation is returned only through an explicit repair
status/API, never disguised as a rolled-back failure. Results name the commit
point and finalization error without returning operation scratch paths that may
contain credentials.

No secret-bearing URL or credential material may appear in logs or results.

### 7.5 Git Bridge tests

Add focused tests for:

- default branch `main`;
- non-`main` default branch;
- discovery failure;
- empty remote;
- explicit branch bypassing discovery;
- clone/preparation failure leaves both absent and pre-existing declarations
  untouched;
- failure after configuration but before protected-main publication
  compare-and-restores a different prior remote/upstream exactly when the
  operation still owns its write;
- compensation failure reports both causes;
- concurrent configuration change during pre-commit compensation is preserved
  and produces `requires-repair`;
- symlink and submodule rejection;
- executable-mode preservation;
- tracked files matching normal scratch names are imported unchanged;
- worktree-only and concurrently-created untracked files are not imported;
- no partial publish after fidelity failure;
- failure after protected-main publication resumes marker/config notification
  and context adoption without reversing the committed import;
- process restart resumes a `committed-incomplete` operation;
- import into `projects/vibestudio` followed by context adoption;
- idempotent export and upstream status after import.

## 8. Host-owned toolchain and CLI unification

### 8.1 Toolchain layout

Each host build publishes an immutable directory:

```text
<host-state>/toolchains/<build-id>/
  manifest.json
  bin/
    vibestudio
    vibestudio.cmd
  cli/
    client.mjs
  runtime/
    node          # node.exe on Windows; exact host-owned compatible runtime
```

`manifest.json` contains the host build ID, Vibestudio version, CLI artifact
hash, launcher hash, runtime hash/version, platform, architecture, and creation
time. A platform may use an equivalent immutable runtime already shipped inside
the same host distribution—for example an Electron executable invoked in Node
mode—but the manifest must identify and hash it and the launcher must not search
for it. Publish to a temporary directory, verify the launcher with an empty
ambient `PATH`, then atomically activate it.

The launcher resolves its CLI and runtime from its own manifest. It must not
depend on the source checkout, current working directory, `node_modules/.bin`,
`/usr/bin/env node`, or a global package installation. Existing processes keep
their immutable toolchain path; activation changes only the pointer used for
new processes.

### 8.2 Environment injection

The extension process manager prepends the active toolchain `bin` directory
exactly once. It also provides non-secret provenance such as:

- `VIBESTUDIO_TOOLCHAIN_DIR`;
- `VIBESTUDIO_HOST_BUILD_ID`.

Every extension inherits this non-secret toolchain environment. The shell's
existing environment sanitization preserves the injected `PATH`. Native child
processes receive it only through the explicit environment construction in
section 8.3. A dev-built child host creates a toolchain for its own artifacts
and injects that into its own extensions.

Injection is an environment property. Toolchain files are never written into a
context, GAD state, or project repository.

### 8.3 Native process delegation boundary

The extension process itself legitimately receives a host RPC token and private
storage location. Those values stop at the extension boundary. Every native
spawn is constructed from a per-purpose allowlist rather than `{...process.env}`.
At minimum, bootstrap/build, dev hub, Electron, Claude Code, and helper-process
launchers remove:

- `VIBESTUDIO_EXTENSION_RPC_TOKEN` and the extension gateway/storage variables;
- parent host admin, bearer, refresh, invite, and agent credentials;
- inspector/debug endpoints and loader injection such as `NODE_OPTIONS`,
  `LD_PRELOAD`, and `DYLD_*` unless explicitly required and approved;
- another host's toolchain provenance;
- terminal-control endpoints except for descendants of that exact managed
  terminal session.

Allowed locale, home, temporary-directory, toolchain, and target-specific
variables are assembled explicitly and recorded by name. Output-affecting
non-secret values participate in `declaredEnvironmentHash`. Secrets never do;
when a child needs authority it receives a purpose-bound credential through a
private profile/file descriptor or platform-equivalent mechanism:

- Claude receives only its linked-agent credential;
- a dev-built Electron client receives only its one-time pairing material;
- the child hub receives no credential for its parent host;
- the supervisor's child device credential and management material remain in
  supervisor storage and are used only by the direct client.

Files are created with private permissions, but same-user permissions are not
advertised as hostile-code containment. An optional future OS sandbox can
strengthen the boundary; it does not justify passing ambient host credentials
today.

### 8.4 Replace `snug` with `vibestudio terminal`

The generated `snug` executable is removed. Its user-facing operations move
under:

```text
vibestudio terminal list
vibestudio terminal badge <text> [--color <color>]
vibestudio terminal label <label>
vibestudio terminal meta set|get|delete ...
vibestudio terminal notify ...
vibestudio terminal send ...
vibestudio terminal split ...
vibestudio terminal open ...
```

The shell extension injects only a session-local endpoint:

- Unix: a private Unix-domain socket;
- Windows: a private named pipe;
- environment key: `VIBESTUDIO_TERMINAL_ENDPOINT`.

The endpoint is created before the shell process, bound to exactly one session
after successful spawn, and removed on exit. Its parent directory/pipe ACL is
private to the host user. Possession of the endpoint is the local capability;
no reusable token is exposed in the environment.

The CLI recognizes the `terminal` namespace before normal credential
resolution. It requires the terminal endpoint and fails clearly when invoked
outside a managed terminal. It never falls back to network RPC.

### 8.5 Typed terminal protocol

Replace argv-over-JSON with a versioned typed request union. Parsing belongs to
the CLI; the terminal-control server receives validated operations. Bind the
protocol version to the host toolchain build contract rather than an unrelated
`snug 0.1.0` constant.

The server continues to enforce:

- session ownership;
- reserved metadata keys;
- notification rate limits;
- URL scheme and approval requirements;
- target-session ownership for `send`;
- cleanup of stale endpoints.

There is no permanent `snug` alias. Update the terminal panel, tests,
documentation, OSC source labels, metadata names where they are not durable
compatibility contracts, and generated help in the same change.

### 8.6 Toolchain and process-boundary acceptance tests

- Ambient `PATH` has no `vibestudio`: every extension and shell resolves the
  host launcher.
- Ambient `PATH` starts with a fake global `vibestudio`: the host launcher
  still wins.
- Ambient `PATH` contains neither Node nor `vibestudio`: the host launcher still
  runs using the manifest-pinned runtime.
- A child host resolves its own build, not its parent host's build.
- Repeated environment preparation does not duplicate the toolchain path.
- `vibestudio --version` reports build identity.
- Every `vibestudio terminal` operation retains the current security tests.
- Terminal invocation outside a managed session fails without trying network
  credentials.
- Unix socket and Windows pipe lifecycle tests prove private ownership and
  cleanup.
- Bootstrap/build, child hub, Electron, and Claude environment-capture tests
  prove that parent extension RPC/storage/admin credentials are absent and only
  the declared child capability is present.

## 9. Reusable direct RPC client

### 9.1 Package

Extract transport-neutral logic from `src/cli/rpcClient.ts` into a Node-safe
package, provisionally `@vibestudio/direct-client`.

It owns:

- HTTP, WebSocket, and WebRTC transports;
- bearer refresh and in-process token caching;
- raw agent-token authentication;
- typed service calls and streams;
- push/event recovery and connection retention;
- connection identity verification;
- loopback pairing and workspace routing primitives;
- abort, timeout, close, and reconnect behavior.

It does not own:

- argument parsing;
- console formatting or process exit codes;
- CLI config paths;
- a global credential store;
- interactive prompts;
- Electron UI.

Those are adapters supplied by the CLI, Electron, or dev-host extension.

### 9.2 Proposed surface

```ts
interface DirectClientOptions {
  endpoint: string;
  credential: DeviceCredential | AgentCredential;
  pairing?: WorkspacePairing;
  expectedHost?: HostIdentity;
}

interface DirectClient {
  call<T>(method: string, args: unknown[], options?: CallOptions): Promise<T>;
  stream<T>(method: string, args: unknown[], options?: CallOptions): AsyncIterable<T>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  service<S extends ServiceSchema>(schema: S): TypedServiceClient<S>;
  close(): Promise<void>;
}
```

The concrete API should reuse existing service-schema and transport types
rather than duplicate them. The CLI's eval command becomes a thin adapter that
resolves scope, reads code, calls the typed eval client, and formats output.

### 9.3 Identity requirements

Connections to a dev-built child must verify the ready payload's host identity,
not merely a port. If a loopback port now belongs to another host, reconnect
must fail or use the explicitly paired route; it must not silently address the
new listener.

The package never accepts the child admin token as an RPC credential.

### 9.4 Migration

Migrate in this order:

1. Extract pure transport and credential types with behavior-preserving tests.
2. Move WebSocket/WebRTC clients and refresh logic behind the package.
3. Adapt the current CLI.
4. Adapt Electron/hub loopback pairing.
5. Use the package from the dev-host extension.
6. Delete CLI-private duplicate paths.

## 10. Context workspace synchronization

### 10.1 Why this is required

The server's context folder is a projection. Normal runtime filesystem and VCS
APIs record edits in GAD and then project them, but a native external editor
writes directly to disk. Treating that disk drift as canonical would violate
I1 and lose provenance.

Claude Code and other native editors therefore need a managed writable mirror.
The existing `vibestudio context mirror --watch` establishes the right model:
read GAD state through the mirror service and write local changes through
`vcs.edit`.

### 10.2 Shared synchronization engine

Extract the mirror/watch mechanics from the CLI into a reusable Node package or
host library used by:

- `vibestudio context mirror --watch`;
- the Claude Code extension;
- future local editor integrations.

The engine accepts explicit read and write adapters, so a trusted extension can
use its runtime client without shelling out to `vibestudio`.

### 10.3 Required correctness beyond v1

The synchronizer is a per-repository CAS state machine. Its durable checkpoint
contains the last acknowledged GAD working-state hash, the materialized
generation, the canonical path/mode set, and any unacknowledged local journal.
Each journal batch has a stable client edit ID. The canonical `vcs.edit` method
must durably deduplicate that ID within `(caller, head, repo)` and return the
original result when the same batch is retried; this is an idempotency field on
the existing edit path, not a second write channel.

For each outbound batch it:

1. computes changes relative to the acknowledged checkpoint;
2. records the local journal durably before RPC;
3. sends one repo-scoped `vcs.edit` with the stable client edit ID and
   `baseStateHash` equal to that exact checkpoint;
4. advances the checkpoint only to the state hash returned by the successful
   edit; and
5. retains the journal when the outcome is unknown and retries only with the
   same client edit ID, obtaining the original result rather than applying the
   edits twice.

A CAS rejection is a conflict, not a reason to retry the same writes against
the new head. The synchronizer stops outbound mutation for that repo, preserves
the local bytes and remote target identities, and asks the normal context VCS
workflow to reconcile them. While local changes are unacknowledged or the
connection is down, inbound materialization may not overwrite those paths.

The production synchronizer must additionally support:

- binary-safe reads and writes;
- regular/executable file mode preservation;
- file creation, modification, deletion, and rename;
- inbound deletion of files absent from the next state;
- staged and journaled per-file inbound application;
- durable state-hash checkpoints;
- echo suppression based on applied generations, not a transient path set;
- debounce and batching into minimal per-repo `vcs.edit` calls;
- local-scratch policy that never ignores a path present in the canonical GAD
  state merely because its name resembles dependencies, build output, a log,
  an environment file, or editor state;
- detection of case collisions and unsupported local entry types;
- an initial drift check before launch;
- a final flush before process completion;
- actionable conflict and disconnected states;
- reconnect without replaying already acknowledged edits.

An atomic whole-directory swap is allowed only when no native process is
attached. Replacing the directory under a running process can leave its cwd and
open files in a detached inode tree, so an attached mirror always uses the
journaled per-file path and generation barrier. Rename is represented as an
atomic delete/create edit batch against one base unless the canonical VCS gains
a native rename operation.

The synchronizer does not invent content merge behavior. It makes concurrency
visible through the existing `baseStateHash` guard, then delegates the explicit
resolution to the context's normal edit/commit/merge semantics.

### 10.4 Mirror layout

Writable mirrors live in extension or CLI state, not inside GAD:

```text
<extension-storage>/context-workspaces/<workspace-id>/<context-id>/
  .vibestudio-context.json
  .vibestudio-sync.json
  projects/vibestudio/
```

Dependencies and build output may live beside the mirrored source only under
paths classified as local scratch because they are absent from the canonical
path set. If such a path later appears in GAD, canonical content wins and the
synchronizer blocks until local scratch is relocated; it never silently ignores
the tracked path. Synchronizer metadata is private scratch and never becomes a
GAD edit.

## 11. The `devHost` service and extension

### 11.1 Placement

Add:

- shared `devHost` service schemas and typed runtime client;
- a host `devHost` service;
- provider slot `providers.devHost`;
- trusted extension `@workspace-extensions/dev-host`.

Use this service instead of generic `extensions.invoke`. It creates a stable,
documented platform surface and keeps authorization in the host.

The service is enabled only after Runtime Foundations R3 can enforce
resource-scoped capabilities centrally. Provider input is host-minted: the
extension receives the already-authorized caller/owner identity, source ref,
execution grant, and launch capability; it never trusts caller-supplied context,
owner, state hash, or authorization fields.

### 11.2 Launch targets

Use a discriminated target, not interacting booleans:

```ts
type DevHostTarget =
  | {
      kind: "isolated-host";
      client: "none" | "electron";
      persistence: "ephemeral" | "retained";
    }
  | {
      kind: "current-host-client";
      client: "electron";
    };
```

`isolated-host` builds the selected context state, starts a new hub with an
isolated config root, waits for a verified ready payload, pairs a normal device,
and optionally starts Electron.

`current-host-client` builds Electron from the selected context state and
pairs it to the current host using a normal device invite minted for the
authenticated caller.

### 11.3 Public methods

The service should expose a narrow surface:

```ts
devHost.launch(input): Promise<DevLaunch>
devHost.status(input?): Promise<DevLaunchStatus[]>
devHost.rebuild(input): Promise<DevBuild>
devHost.stop(input): Promise<DevStopResult>
devHost.eval(input): Promise<DevEvalResult>
devHost.logs(input): AsyncIterable<DevLogEvent>
devHost.watch(input): AsyncIterable<DevLaunchEvent>
```

The exact schema must include:

- launch ID;
- owner principal and authorization scope;
- source repository path;
- caller context ID;
- resolved source state hash;
- dirty/uncommitted count;
- execution input hash and recipe identity;
- target discriminator;
- active and candidate host build IDs;
- lifecycle state;
- readiness identity;
- child workspace/context/session identifiers where relevant;
- start/update timestamps;
- last build or runtime error.

`contextId` defaults to the verified caller context. Agents may not launch
another context merely by naming it. Broader operators require an explicit
policy grant.

Every method authorizes both a capability and a resource. A caller may see,
stream, evaluate, rebuild, or stop only launches it owns in its authorized
workspace/context unless it holds an explicit `devHost.admin` grant. `status()`
does not enumerate other principals' launches by default. Idempotency keys are
scoped to `(owner principal, workspace, context, target, key)` so a caller
cannot discover or capture another caller's operation by collision. Extension
restart recovery preserves the host-minted owner scope.

### 11.4 Lifecycle

```text
requested
  -> snapshotting
  -> awaiting-approval
  -> bootstrapping
  -> building
  -> validating
  -> starting
  -> pairing
  -> promoting
  -> ready(active generation)

ready(active generation)
  -> snapshotting-candidate
  -> awaiting-candidate-approval
  -> building-candidate
  -> validating-candidate
  -> starting-candidate
  -> pairing-candidate
  -> promoting-candidate
  -> ready(new active generation)
  -> retiring-old-generation

Any candidate state -> candidate-failed -> ready(last-good generation)
Any first-launch state -> failed
ready -> stopping -> stopped
```

One launch owner controls each process tree. Transitions are serialized and
persisted enough to recover or clean up after extension restart. Repeated
`launch` with the same idempotency key returns the existing launch.

The lifecycle record distinguishes requested source, candidate artifact,
active artifact, and running process identity. A candidate failure never changes
the active generation's source/build labels. Promotion is a durable transition;
restart recovery can determine whether to finish promotion, retire the old
generation, or restore it.

### 11.5 Source preparation

For each build:

1. The host resolves the invoking context's exact
   `projects/vibestudio` working state and dirty count.
2. The host constructs the complete `ExecutionInput` and authorizes that exact
   input.
3. The execution snapshot service materializes the named repository state
   directly from CAS into a new private root.
4. Verify the root manifest reproduces the requested state hash before exposing
   it to the extension.
5. Attach a private copy-on-write/scratch layer for dependencies and outputs.
6. Record the source state, execution input hash, and snapshot identity in the
   build record.
7. Run the approved bootstrap/build recipe in the sanitized environment from
   section 8.3.

The extension must not use the Git Bridge checkout or the live context
projection. It cannot substitute a disk path supplied by a caller. A mismatch
between the requested state and snapshot manifest is a hard error. Concurrent
context edits create later candidates; they cannot mutate an in-flight build.

### 11.6 Dependencies and cache

Use the project's frozen bootstrap contract, currently
`pnpm bootstrap:frozen`. Dependency installation is code execution and is
approval-gated.

Cache the pnpm content store by:

- lockfile digest;
- platform and architecture;
- Node and pnpm versions.

Keep `node_modules` and generated output inside the execution snapshot's private
writable layer. Never blindly symlink the bootstrap checkout's dependencies
into another source state. A manifest, recipe, builder, target, runtime, or
declared-environment change invalidates the relevant installation/build key.
Cache hits are accepted only after their manifest and artifact hashes verify
against the complete execution input.

Dependency/bootstrap and build commands may execute repository code. The
default approval is bound to the exact execution input hash and displays the
commands, source state, target, and whether the local user OS is unsandboxed.
An approval for one state does not cover a changed lockfile, manifest, recipe,
runtime, builder, or source state.

### 11.7 Build and rebuild

Refactor the useful orchestration from `scripts/dev-webrtc-remote.mjs` into a
reusable supervisor rather than duplicating startup behavior.

Rebuild triggers are canonical context state changes, not broad observation of
dependency/build scratch. Coalesce rapid state advances and build only the
latest state. Each build result records the input state hash.

An ordinary launch stops at `awaiting-candidate-approval` when that latest state
is not covered by an execution grant; the active generation keeps running. An
explicit watch grant may cover future source states only when it is
time-bounded, owner/context/repository/recipe-scoped, revocable, and presented
as authority to execute future script changes. A changed recipe, builder,
target, runtime, or privilege requirement always invalidates the watch grant.

On candidate failure at build, validation, startup, identity verification,
pairing, or required probe:

- keep the last known-good child running whenever the persistence mode permits
  side-by-side validation, or restore it from the journaled retained-data
  handoff before reporting terminal failure;
- report the failed candidate state and diagnostics;
- do not relabel the old child as the new state;
- automatically retry only after the source state changes or an explicit
  rebuild request.

Server-affecting changes restart the isolated host. Client-only changes relaunch
or refresh the dev-built Electron client according to the build output
contract. This classification must be derived from build artifacts, not a
hand-maintained path list. The build emits a role-addressed artifact manifest;
classification compares artifact hashes and declared runtime roles, never file
timestamps or source path guesses.

### 11.8 Supervision and cleanup

Reuse the strict ready-file and process-identity safety from
`HubProcessManager`:

- private isolated config root;
- fresh ready file with nonce/build identity;
- verified child PID and gateway identity;
- bounded readiness timeout;
- separate stdout/stderr capture with secret redaction;
- crash backoff and restart-storm cutoff;
- process-group or job-object ownership;
- cleanup only after identity verification.

An extension restart reconciles recorded PIDs and ready identities before
adopting or terminating anything.

All spawned environments follow section 8.3. In particular, a child hub never
inherits the parent extension RPC token, and build/install scripts never run
with provider authority.

For `persistence: "ephemeral"`, each candidate uses a distinct config/data root
and may start beside the active generation; promotion switches the launch
record only after readiness and pairing, then retires the old root. For
`persistence: "retained"`, the durable data root is single-writer. The
supervisor first validates the candidate against an operation-owned probe root,
then performs a journaled handoff: quiesce the old process, snapshot/verify the
retained data, start the candidate, and either commit promotion or restart the
last-good artifact against the verified pre-handoff data. It never starts two
hubs on one retained root or destroys the rollback artifact before promotion.

### 11.9 Managed Electron client isolation

Every dev-built Electron client runs in a launch-owned desktop profile selected
before Electron requests its single-instance lock. Managed-dev mode supplies a
unique user-data directory and singleton namespace, so the normal Vibestudio
desktop and multiple dev clients can coexist.

Managed-dev mode also:

- connects only to the explicitly paired target and never auto-spawns a local
  hub;
- disables global protocol-handler registration, auto-update state, default-app
  mutation, and reuse of ordinary desktop credentials;
- stores any paired device credential only in the private launch profile and
  removes it with that generation;
- sanitizes the environment according to section 8.3;
- reports a ready identity containing launch ID, client build ID, profile ID,
  and connected host identity; and
- is supervised and promoted as a candidate process rather than launched
  fire-and-forget.

Before issuing pairing material, the current host compares its canonical RPC,
pairing, and required service-schema versions with the candidate client's
declared compatibility range. Incompatible source fails clearly and directs the
caller to `isolated-host`; it does not consume an invite or mutate the ordinary
desktop profile.

## 12. Authentication and direct eval

### 12.1 Isolated host

The supervisor reads the strict child ready payload, then completes ordinary
loopback pairing as a root/device identity. It stores the device credential in
private extension storage with mode `0600` or platform-equivalent ACL.

The admin token may be used only for documented management probes. It is added
to secret redaction, never placed in a child/build environment, and never
returned through `devHost`. Private storage and environment scrubbing prevent
accidental delegation; because approved same-user code is not an OS sandbox,
the plan does not claim mode `0600` alone protects secrets from intentionally
hostile code running as that user.

### 12.2 Current-host client

The dev-host extension principal cannot impersonate the caller or mint an
invite by bypassing policy. The host `devHost` service invokes the existing
hub-control pairing operation on behalf of the authenticated user subject and
passes only the resulting invite to the provider.

The invite is single-use, redacted, never persisted in the launch record, and
delivered only to the launch-owned profile. The dev-built Electron client then
follows the existing pairing/deep-link flow.

### 12.3 Eval

`devHost.eval` is the sandbox-facing API. The call path is:

```text
agent/runtime caller
  -> current host devHost policy
  -> trusted dev-host extension
  -> @vibestudio/direct-client
  -> child host typed eval service
```

The extension creates or selects a child runtime session/entity/context through
canonical RPC, then calls `eval.run`. It returns typed eval results and
diagnostics, never credentials or raw transport handles.

This is direct RPC: there is no CLI subprocess and no custom relay protocol.
The current host service remains the credential boundary.

`eval`, `logs`, and `watch` re-authorize launch ownership on every call and
stream resume. Eval defaults to the active generation and records its
build/source identity. It never silently addresses a candidate or a newly bound
process on a reused port; selecting a non-active retained generation requires
an explicit operator capability.

## 13. Claude Code integration

### 13.1 First-class availability

Claude Code remains a supported subagent kind:

```ts
spawn_subagent({
  agentKind: "claude-code",
  task: "Implement and verify the requested UI change",
});
```

Agent-facing discovery should report availability and degradation reason before
launch. UI-oriented guidance may recommend Claude Code, but routing remains an
explicit agent/human decision rather than an opaque automatic heuristic.

### 13.2 Preflight health

Extension activation or a dedicated doctor checks:

- Claude executable resolution;
- supported Claude version;
- required channel/plugin flags;
- canonical plugin files and hashes;
- the injected `vibestudio` launcher and host build ID;
- writable context-workspace capability;
- ability to create the linked-agent credential without exposing it;
- ability to construct a Claude child environment with no parent extension
  credential or storage authority.

Failure produces a degraded provider with an actionable status. The extension
must not advertise healthy merely because its JavaScript activated.

### 13.3 Canonical plugin

Package one Claude plugin with the host distribution. It owns:

- MCP server configuration;
- lifecycle hooks;
- Vibestudio channel support;
- the generated Vibestudio agent skill;
- plugin metadata and marketplace/install metadata where external adoption is
  supported.

Internal launch uses an exact:

```text
--plugin-dir <host-build>/plugins/vibestudio
```

Delete duplicate generated MCP/hook profiles and context-local skill copies.
Generate the plugin skill from the canonical agent skill during the build so
the two cannot drift.

### 13.4 Working tree

Before launching Claude:

1. Resolve the target context and repository scope.
2. Start or attach the context workspace synchronizer.
3. Wait until its local state checkpoint equals the GAD state hash.
4. Launch Claude with its cwd inside that writable mirror.
5. Keep inbound and outbound synchronization active for the process lifetime.
6. Flush local edits with the checkpoint as `baseStateHash` and wait for their
   acknowledged result before reporting completion.

Default scope is the requested repository; for generic interactive launches
without a narrow target, correctness defaults to `all`.

Claude must never be launched into the sparse context root or a projection
whose raw disk edits are not recorded.

If final flush encounters a CAS conflict, disconnect, or unknown RPC outcome,
the subagent result is not reported as clean completion. The mirror and journal
are retained in an actionable recovery state, and the parent sees that the
working bytes are preserved but not yet acknowledged by GAD.

### 13.5 Lifecycle and security

Preserve the existing linked-agent entity, channel, bound agent credential,
permission relay, crash reporting, and terminal settlement model.

Add guarantees that:

- the agent token is passed only to the Claude process/profile that needs it;
- the Claude environment is built from the section 8.3 allowlist and excludes
  the extension RPC token, extension storage path, management credentials, and
  unrelated terminal endpoints;
- generated profile files and plugin state are private;
- logs and launch status do not contain tokens;
- process exit releases credentials, sockets, synchronizer, and vessel state;
- a crash becomes a visible terminal failure rather than a silently idle
  subagent.

## 14. Import and cutover procedure

### 14.1 Prerequisites

Do not import until:

- Git Bridge hardening in section 7 is complete;
- the shared immutable execution-snapshot primitive and resource-scoped R3
  authorization needed by `devHost` are complete;
- host toolchain injection and its owned runtime work with an empty ambient
  `PATH`;
- native process environment isolation passes for build, hub, Electron, and
  Claude children;
- isolated dev-host launch and direct eval pass system coverage;
- managed Electron profile/singleton isolation works beside the ordinary
  desktop;
- the project remote and default branch are confirmed;
- the source repository passes fidelity preflight.

### 14.2 Preserve current work

The bootstrap checkout may contain commits not on the remote and uncommitted
changes. A Git clone cannot import the latter.

Before cutover:

1. Freeze new writes to the bootstrap checkout.
2. Record branch, HEAD, upstream relation, staged changes, unstaged changes,
   untracked files, and submodule/symlink inventory.
3. Commit and publish changes that belong on the canonical remote.
4. Preserve any intentionally uncommitted carryover as an explicit reviewed
   patch/inventory.
5. Confirm the remote tree expected to be imported.

Do not add a dirty-checkout import mode to Git Bridge.

### 14.3 Import

From the intended workspace context, call the canonical runtime equivalent of:

```ts
await git.importProject({
  path: "projects/vibestudio",
  remote: {
    name: "origin",
    url: "<current canonical origin>",
  },
});
```

Verify:

- import operation phase is `complete`, with no `committed-incomplete` repair
  record;
- resolved upstream branch;
- imported Git commit provenance;
- GAD main state hash;
- file count, executable modes, and representative binary hashes;
- no tracked entry—including files with scratch-like names—was omitted;
- `autoPush` remains false;
- the invoking context adopted the repository.

### 14.4 Replay uncommitted carryover

Apply reviewed carryover through normal GAD working edits in the new context.
Confirm `vcs.status` reports the expected uncommitted count and compare the
resolved context tree with the pre-cutover inventory.

The carryover is now ordinary context state. Commit and push it through the
normal edit -> commit -> push workflow when ready.

### 14.5 Switch authority

After acceptance:

- all new development begins in `projects/vibestudio`;
- dev builds consume only private CAS snapshots of resolved context state;
- Git Bridge performs upstream ingress/egress only;
- the bootstrap checkout becomes read-only recovery material and is then
  archived or removed deliberately;
- no process mirrors GAD pushes back into it.

There is no dual-write transition period. If cutover validation fails, stop
and repair the canonical path before resuming development.

## 15. Removal and documentation work

Delete or replace:

- the dead self-update behavior in `scripts/start-dogfood-server.mjs`;
- documentation claiming GAD changes mirror into the host checkout;
- `meta/dogfood.json` semantics that exist only to describe that mirror;
- the generated `snug` executable and its temporary bin directory;
- duplicated Claude profiles, hooks, and context-local skill copies;
- CLI-private RPC implementations after all adapters use the direct-client
  package.

Update at least:

- root README self-development guidance;
- `docs/cli.md`;
- onboarding remote-server documentation;
- system-testing self-improvement guidance;
- workspace-dev skill guidance;
- extension runtime documentation;
- Claude Code channel/plugin documentation;
- architecture RPC/service documentation;
- execution-snapshot, native process delegation, and approval-grant contracts;
- packaged CLI/runtime and plugin artifact contracts;
- managed-dev Electron profile/singleton behavior and its non-effects on the
  ordinary desktop.

Historical design documents may remain historical, but they must be marked
superseded where their instructions conflict with this plan.

## 16. Implementation workstreams

### WS0. Contracts and truthfulness

- Land this architecture as the governing plan.
- Reconcile Runtime Foundations R2 so artifact identity includes the
  builder/toolchain/target tuple and expose the shared execution-snapshot
  contract without making `projects/vibestudio` a Build V2 unit.
- Add service/package names and breaking-change entries.
- Correct docs that currently promise host-checkout mirroring.
- Define planned system-test cases before implementation.

Exit: no active documentation instructs agents to rely on a working mirror.

### WS0A. Execution and authorization foundations

- Implement direct CAS-to-private-root execution snapshots and complete
  `ExecutionInput` hashing.
- Adapt Build V2 to the same lower-level primitive while retaining EV as its
  unit content identity.
- Land the resource-scoped R3 checks required by every `devHost` method and
  execution grant.
- Add the shared allowlisted native-process environment builder and secret
  stripping assertions.
- Add referenced artifact retention for active, candidate, pinned, and rollback
  generations.

Exit: a state can be materialized and built while its live context changes
without input drift; changing builder/target/runtime/environment changes the
execution identity; an unauthorized principal cannot observe or control another
launch; and native children contain no parent provider credential.

### WS1. Git Bridge correctness

- Make branch discovery definitive.
- Split import into prepared, committed, and idempotent finalization phases with
  a durable operation journal and compare-and-restore pre-commit compensation.
- Import the resolved Git object tree and add tracked-entry fidelity validation
  without filename-based ignores.
- Expand result/provenance and tests.

Exit: all section 7 tests pass; pre-commit failure changes no authoritative
state; post-commit failure resumes to completion without false rollback; and
concurrent configuration changes are never overwritten.

### WS2. Toolchain and terminal CLI

- Implement atomic host toolchain publication with an owned, manifest-pinned
  JavaScript runtime.
- Inject it through the extension process manager.
- Migrate host-created native spawns to the shared environment allowlist.
- Move `snug` commands into `vibestudio terminal`.
- Implement private Unix socket/Windows named-pipe terminal endpoints.
- Remove the standalone command.

Exit: empty/hostile-`PATH`, child-environment isolation, and terminal
security/lifecycle coverage passes.

### WS3. Direct client extraction

- Create `@vibestudio/direct-client`.
- Migrate CLI transports/auth with no behavior change.
- Share loopback pairing and host identity verification.
- Remove duplicated CLI-private protocol logic.

Exit: CLI, WebRTC, push, refresh, and eval suites pass through the package.

### WS4. Context workspace synchronizer

- Extract and harden mirror/watch.
- Add per-repo checkpoint/journal state, `baseStateHash` writeback, binary,
  delete, mode, attached-tree, drift, conflict, and reconnect semantics.
- Make scratch ignores conditional on absence from the canonical path set.
- Adapt `vibestudio context mirror --watch`.

Exit: native file edits round-trip to GAD working edits; stale writes produce a
preserved, actionable CAS conflict; and inbound changes reconcile without
loops, cwd detachment, ignored tracked paths, or loss.

### WS5. Isolated dev host

- Add service schema, policy, provider, extension, lifecycle store, build
  cache, and supervisor.
- Build from a private execution snapshot of the exact context state with a
  state-bound or explicit watch execution grant.
- Start isolated hub, pair normal device, and expose direct eval.
- Promote validated candidates and restore the last-good retained generation on
  startup/pairing/probe failure.

Exit: a dirty context launches a verified child whose eval observes the dirty
content; a concurrent edit cannot contaminate its build; and every candidate
failure preserves or restores the correctly-labelled last-good generation.

### WS6. Dev client against current host

- Add caller-bound invite minting in the host service.
- Build and launch Electron against the current server.
- Reuse pairing/deep-link behavior.
- Add managed-dev profile/singleton isolation, global-side-effect suppression,
  compatibility preflight, readiness identity, and candidate supervision.

Exit: a context-built client connects to the current server without shared
credentials, admin-token use, ordinary-profile mutation, or conflict with the
running desktop.

### WS7. Claude Code hardening

- Package one canonical plugin.
- Add toolchain/plugin/version health.
- Launch in the synchronized writable context workspace.
- Use R4-owned channel membership and the sanitized child environment.
- Add real lifecycle/system coverage.

Exit: a Claude subagent edits `projects/vibestudio`, the edit appears as a
GAD working edit, no parent extension authority reaches Claude, and
completion/conflict/crash cleanup is truthful.

### WS8. Canonical import and cleanup

- Preserve/bootstrap current work.
- Import the monorepo.
- Replay reviewed dirty carryover.
- Run acceptance coverage.
- Retire old dogfood/bootstrap paths and finish documentation.

Exit: daily development no longer depends on the original source checkout.

WS1, WS2, WS3, and WS4 depend only on the WS0 contracts and may proceed without
waiting for the full runtime-foundations program. WS5 depends on WS0A, WS2,
WS3, WS4, and the required R3 substrate. WS6 depends on the WS5 supervisor and
managed-client mode. WS7 depends on WS2, WS4, and R4 ownership. WS8 waits for
all acceptance gates; it is the only authority cutover.

## 17. Verification strategy

### 17.1 Conventional tests

Each workstream adds focused unit and integration tests for its contracts.
Required broad checks include:

- shared service schema contract tests;
- resource-scoped service capability/ownership and idempotency-key isolation
  tests;
- execution snapshot manifest, concurrent-context-mutation, build-key, cache,
  and artifact-retention tests;
- extension-host and native-child allowlisted environment capture tests;
- Git Bridge bridge/upstream/service tests with fault injection at every import
  journal phase;
- CLI parser, transport, credential, and eval tests;
- context synchronizer CAS/conflict/attached-cwd tests on real temporary
  filesystems, including lost-response retry with one durable client edit ID;
- hub supervisor, retained-data handoff, candidate promotion, and ready-file
  identity tests;
- managed Electron profile, singleton, global-side-effect, credential cleanup,
  and compatibility tests;
- Claude extension/profile/channel-host tests;
- type checks for root and affected workspace packages.

### 17.2 Headless agentic tests

Add exact cases:

- `git-import-non-main-default`;
- `git-import-fidelity-rejection`;
- `git-import-post-commit-resume`;
- `git-import-concurrent-config-preserved`;
- `host-toolchain-path-isolation`;
- `host-toolchain-owned-runtime`;
- `context-mirror-native-edit-roundtrip`;
- `context-mirror-cas-conflict-preserves-local`;
- `dev-host-launch-dirty-context`;
- `dev-host-immutable-snapshot-race`;
- `dev-host-state-bound-approval`;
- `dev-host-process-authority-isolation`;
- `dev-host-candidate-startup-rollback`;
- `dev-host-direct-eval`;
- `dev-client-current-host`;
- `dev-client-profile-isolation`;
- `dev-client-version-skew-rejection`;
- `claude-code-materialize-edit-complete`;
- `claude-code-no-parent-authority`;
- `claude-code-crash-cleanup`.

For every implementation repair, follow repository policy:

1. doctor;
2. smallest exact test;
3. inspect run and full trajectory on failure;
4. fix the classified root cause;
5. rerun exact;
6. run its category;
7. run smoke.

### 17.3 End-to-end acceptance

The final cutover exercise must prove:

1. Import `projects/vibestudio` from the canonical remote and verify the durable
   operation is `complete`.
2. Create an uncommitted GAD edit that changes a visible client marker and a
   server eval result.
3. With the ordinary desktop already running, launch `current-host-client`;
   observe the marker against the current server and prove its profile,
   singleton, credentials, updater, and protocol registration are isolated.
4. Launch `isolated-host`; verify its source state, execution input hash, host
   build ID, target/runtime identity, and sanitized process environment.
5. During an intentionally delayed build, advance the context; prove the first
   artifact contains only its original state and the later state becomes a
   separate candidate.
6. Call `devHost.eval`; observe the uncommitted server result from the active
   generation and its recorded identity.
7. Open a child terminal with ambient Node and `vibestudio` removed and prove
   the child's manifest-owned CLI/runtime works.
8. Use `vibestudio terminal` to update terminal UI state.
9. Launch a Claude Code subagent, make a file edit, and confirm it becomes a
   CAS-guarded GAD working edit with provenance and no parent extension
   credential in the Claude environment.
10. Create a concurrent inbound/local edit; confirm the local bytes and journal
    are preserved, the stale write is rejected, and completion reports the
    conflict rather than overwriting either side.
11. Advance source outside the current execution grant; confirm rebuild pauses
    for approval while the active generation remains available.
12. Introduce a build error; confirm the last good host stays available and the
    failed candidate is reported accurately.
13. Introduce candidate startup and pairing failures; confirm ephemeral mode
    keeps the old generation and retained mode restores it through the journaled
    handoff.
14. Fix the error; confirm a coalesced, approved rebuild promotes the new state
    and only then retires the old generation.
15. Attempt a current-host client with incompatible protocol declarations;
    confirm it fails before consuming an invite or changing any desktop profile.
16. Stop the launch; confirm processes, credentials, endpoints, ready files,
    snapshots, profiles, and scratch ownership are cleaned without affecting
    the parent host or another owner's launch.
17. Export through Git Bridge and verify upstream status/provenance.

## 18. Observability

Every launch emits structured lifecycle events with:

- launch ID, owner authorization scope, target, and execution-grant identity;
- workspace/context/repository;
- requested, candidate, and active source/build/execution-input hashes;
- dirty count;
- parent and child host build identities;
- builder, recipe, target, runtime, snapshot, and declared-environment
  identities;
- phase and duration;
- process identity;
- readiness identity;
- promotion/rollback generation and retained-data handoff outcome;
- build diagnostic summary;
- retry/restart count;
- cleanup outcome.

Logs must redact:

- parent extension RPC tokens and private provider environment;
- admin and bearer tokens;
- pairing codes and refresh credentials;
- credential-bearing remote URLs;
- Claude agent tokens;
- private profile contents.

`devHost.status` should be sufficient to answer what source is running,
where, with which client, and why a build or launch failed without reading raw
logs.

## 19. Definition of done

The program is complete only when all of the following are true:

- `projects/vibestudio` is the canonical development repository in GAD.
- Git import is branch-correct, commit-point-correct, resumable, concurrency-safe,
  and faithful to every tracked Git tree entry.
- Uncommitted context edits are immutable CAS build inputs and are named in
  launch status with the full execution input identity.
- No build reads or copies the live context projection, and an edit during a
  build cannot contaminate its artifact.
- Both launch targets work from the same service and extension.
- Every `devHost` method enforces resource-scoped capability and launch
  ownership.
- Userland can call child eval through typed direct RPC without credentials.
- The exact host CLI and runtime are available in every host-created execution
  environment without ambient Node or `vibestudio`.
- Build, hub, Electron, and Claude children do not inherit parent extension or
  management authority.
- `snug` no longer exists; `vibestudio terminal` preserves its capabilities
  and security.
- Claude Code launches in a synchronized writable tree and is visibly
  health-checked/discoverable to agents; stale synchronization preserves both
  sides and reports conflict.
- The child admin token is never accepted or exposed as an RPC credential.
- Execution approvals are exact-state-bound unless the user explicitly grants
  a time-bounded future-state watch capability.
- Build, validation, startup, identity, pairing, and probe failures preserve or
  restore the correctly-labelled last-good generation.
- Managed dev clients use isolated profiles/singletons and make no global
  desktop mutations.
- Old dogfood mirroring and contradictory documentation are removed.
- Focused, category, smoke, and final end-to-end acceptance coverage pass.

## 20. Audit baseline

The read-only audit that produced this plan established the following baseline:

- 183 focused Git Bridge, Claude, RPC, context, extension-host, and hub tests
  passed.
- System-test doctor passed with 148 tests discoverable.
- Exact `git-import-project` passed with no unexpected tool failures.
- The full `git-interop` category passed 4/4.
- The smoke category passed 4/4.

This proves the existing Git import happy path. It does not close the
commit-point/failure-mode, immutable execution, capability/process-delegation,
toolchain/runtime, direct-client, synchronizer, managed-client, promotion, or
Claude working-tree gaps specified above.

# Runtime Foundations Refactor — Exact Execution, Hermetic Builds, and Explicit Authority

Status: implemented 2026-07-14; this document is the authoritative runtime,
authority, bootstrap, and channel-lifecycle contract

Compatibility policy: this is a pre-release, self-contained codebase. The refactor
is a clean cut. Replaced APIs, schemas, identities, and runtime paths are removed in
the same tranche that introduces their replacement; there are no feature flags,
compatibility readers, conversion shims, or parallel authorization/execution paths.
That permission to make a clean architectural break does **not** permit accidental
product changes. Existing user workflows, update timing, collaboration behavior,
prompts, failure recovery, and visible state are contracts unless a change is
separately enumerated and accepted in R3B.

Related: `trusted-workspace-units.md`,
`multi-user-wp9-trust-role-attenuation.md`, `stage0-unified-log-spec.md`,
`ws2-channel-spec.md`, `system-agent-design.md`

## 0. Objective

The current runtime has three architectural mismatches:

1. Source closure, build inputs, artifacts, and running code are related but are
   not represented by one exact executable identity. Several launch paths still
   resolve a name or moving head implicitly.
2. Authority is split among caller-kind allowlists, user/device identity,
   app-manifest capabilities, workspace relationships, internal-DO privileges,
   and service-local predicates. Those mechanisms cannot safely describe a call
   involving a user, device, runtime entity, and exact code artifact together.
3. Channel creation, admission, discovery, ownership, and presentation mutation
   are conflated. Some behavior is frozen by first use rather than by an explicit
   creation contract.

This refactor installs one exact execution model, one compositional authorization
model, and one explicit channel lifecycle. It remains ambitious: special internal
paths and caller-kind authorization disappear. It also becomes meticulous: every
current user-visible behavior is inventoried and protected by parity fixtures
before its substrate is replaced.

### 0.1 Success criteria

At completion:

- Every execution is attributable to a full, host-verified execution digest.
- Historical and pinned executions are reconstructible without live filesystem
  input, mutable registries, or a warm cache.
- A logical entity has a stable identity and storage namespace while its exact
  code incarnations form an append-only, auditable history.
- Upgrade selection and upgrade adoption are explicit, separate policies.
- Every privileged method on both RPC planes declares its complete authority and
  relationship requirements. Caller kind is never an authorization decision.
- Current allowed actions, denials, prompts, update timing, reload timing,
  collaboration, and recovery remain unchanged through every mechanical cutover;
  only accepted R3B entries may deliberately change policy behavior.
- Intentional policy tightening happens only through the enumerated R3B ledger.
- Channels are explicitly created, have immutable append-only structure revisions,
  retain today's normal multi-human behavior, and can express exact locked channels.
- The minimum host bootstrap authority is small, explicit, content-addressed, and
  auditable. Everything above it uses the ordinary runtime and grant model.
- Each old form is deleted when its replacement lands. There is one answer to
  each architectural question, not a preferred answer plus legacy exceptions.

### 0.2 Non-goals

- Preserving private TypeScript API signatures, serialized runtime-foundation
  metadata, truncated EV strings, or current cache layouts.
- Introducing broad auto-update, auto-navigation, forced panel reload, new
  approval prompts, or owner-only collaboration as a side effect of the refactor.
- Treating capabilities as replacements for ownership, workspace membership,
  device ownership, or delegation provenance.
- Making the host understand product-specific channel semantics.
- Building a second compatibility or authorization layer for the migration.

## 1. Non-negotiable design invariants

1. **Source revision is not executable identity.** A source EV identifies a source
   closure. Toolchain, target, options, dependency resolution, and emitted bytes
   are separate inputs to executable identity.
2. **Persist full hashes.** All security, lookup, provenance, and retention keys
   use full SHA-256 values with domain separation. Short forms are display-only.
3. **Resolve, then execute.** A moving selector may choose an immutable artifact,
   but a launcher never executes a name or selector directly.
4. **Stable entity, immutable incarnation.** Logical identity and durable storage
   survive an upgrade. The code ref on an incarnation never mutates.
5. **Selection is distinct from adoption.** “Which artifact follows this head?”
   and “when does a running surface begin using it?” are different policies.
6. **Artifacts prove outputs.** A build key proves declared inputs; an artifact
   digest verifies canonical emitted bytes. Both are required.
7. **Retention follows authoritative roots.** No increment/decrement reference
   counts are maintained as a second, drift-prone truth.
8. **Authority composes by intersection and predicates, never by union.** A call
   with user, device, code, and delegation facts does not acquire the union of all
   their grants.
9. **Capabilities and relationships are orthogonal.** A capability permits a
   class of action; live ownership, membership, binding, and resource relations
   decide whether this caller may perform it on this object.
10. **Both RPC planes enforce the same contract.** Host service dispatch and
    direct WorkspaceDO RPC cannot diverge in identity propagation or policy.
11. **Shape is not privilege.** Runtime kind may choose decoding or routing but
    cannot authorize an operation.
12. **No accidental authority creation.** Subscription, first connection, cache
    population, and entity lookup never create ownership or grants.
13. **Security changes are product changes.** R3A is exact behavioral parity.
    Every deliberate tightening belongs to R3B with named UX consequences.
14. **Unknown behavior blocks implementation.** It is resolved in R0 and encoded
    as a fixture; it is never filled in with a newly convenient default.

## R0. Freeze the behavioral and authority contracts

R0 is a documentation-and-test tranche and a hard gate for R1-R4 implementation.
It does not add a compatibility path. It records the product that the new
foundations must continue to implement.

### R0.1 Execution and update inventory

Produce a machine-readable ledger of every launch, resolution, rebuild, rollback,
and update-adoption path, including:

- `runtime.createEntity`, `ensureDurableObjectEntity`, `startWorker`, worker and
  DO push rebuilds, agent/subagent spawn, EvalDO, VCS store, Spectrolite, Claude
  Code, panel factories, app targets, extensions, and product bootstrap units;
- the selector currently implied at each call site (`main`, context head, explicit
  state, active build, or pinned build);
- the exact current adoption boundary and user-facing event;
- rollback and failure behavior;
- effects on in-flight RPC, fetches, alarms, WebSockets, durable storage,
  in-memory state, bearer tokens, notifications, navigation, and process restart;
- startup, launch, rebuild, update-notification, and first-interaction latency, plus
  any progress/loading UI that prevents those waits from feeling hung;
- which identifier is written to status, events, logs, approvals, provenance, and
  diagnostics today.

The inventory must cover every runtime kind. An unclassified launch or adoption
path fails the R0 gate.

The target contracts begin with these known behaviors and are refined by fixtures,
not replaced by speculation:

| Surface                                          | Selector behavior                      | Adoption contract to preserve                                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker or DO on `main`                           | Tracks main head                       | A completed matching build advances the loader generation; new requests use the new generation without restarting workerd. Existing concurrent work is not killed.                 |
| Worker or DO on `ctx:<id>`                       | Tracks that context head only          | Same next-request loader behavior, scoped to that context. Unrelated head changes do nothing.                                                                                      |
| Worker or DO on `state:<hash>` or exact artifact | Pinned                                 | Push rebuilds do nothing until an explicit attributed repin.                                                                                                                       |
| DO durable object                                | Stable logical entity and storage      | Durable storage identity survives code adoption. Current alarm, WebSocket, hibernation, and in-memory-instance behavior is captured and retained exactly.                          |
| Panel                                            | Tracks its selected source ref         | Push invalidates the server build cache. An already loaded panel is not forcibly navigated or reloaded; its existing reload/navigation lifecycle fetches the new artifact.         |
| Electron app                                     | App-host selection and version history | An update is queued and surfaced as “Load update”; adoption remains explicit. Existing rollback and error UI remain available. No loaded app is auto-navigated.                    |
| React Native app                                 | App-host selection and version history | A trusted bundle is announced as available; the existing mobile-open/install flow adopts it. No desktop-oriented adoption behavior is invented.                                    |
| Terminal app                                     | App-host selection and process state   | Preserve current immediate registry synchronization plus the existing start/restart notification and process lifecycle. Do not silently kill a running process earlier than today. |
| Extension or other product unit                  | As observed in R0                      | Must receive an explicit row and fixture before its launch path is migrated.                                                                                                       |

Where the known summary is insufficient—for example, a live DO WebSocket across a
loader generation—R0 records the observed current outcome and the intended parity
contract before implementation. “Use the new secure default” is not an answer.

### R0.2 Authority ledger

Generate a complete ledger for every host `serviceSchemas` method and every direct
WorkspaceDO `@rpc` method. Each row records:

- method, owning service, RPC plane, and resource-key derivation;
- currently accepted caller shapes;
- acting-user, device, runtime-entity, code, owner/deputy, workspace-role, agent,
  and delegation facts currently available;
- current allow, deny, and approval outcomes, including error code and prompt copy;
- ownership, membership, session, version, scope, and deny predicates;
- proposed R3A requirement expression;
- any proposed R3B change, kept blank until deliberately reviewed.

Every registered method must have a row. CI compares the generated method census
to the ledger so a new or forgotten method cannot default to ambient access.

### R0.3 Channel behavior ledger

Record current behavior for creation, first subscribe, subsequent subscribe,
invitation, visibility, presence, config mutation, multi-editor use, fork/clone,
owner loss, deletion, reconnect, and the System Agent channel. In particular,
preserve the WP7 contract that `channel_members` is invitation/discovery metadata,
not a hard ACL for ordinary workspace-member channels.

### R0.4 Bootstrap dependency graph

Draw the actual startup dependency graph through source/build storage, entity
storage, authorization/grant resolution, WorkspaceDO registration, context
binding, and product-seed units. The output identifies the smallest acyclic host
root. No internal DO may be declared “ordinary” until the graph shows how the
ordinary runtime exists before that DO starts.

### R0.5 Gate

R0 is complete only when the four ledgers are checked in, their censuses are
complete, every row links to an executable parity assertion, representative flows
also have end-to-end fixtures, and all unknown rows have an explicit decision. A
fixture that fails during implementation triggers investigation of the design; it
is not re-recorded as the new baseline without an accepted product-policy entry. No
foundation implementation begins with an “investigate during migration”
placeholder.

## R1. Exact execution and entity incarnations

### R1.1 Canonical identities

Replace the overloaded `(repoPath, ev)` concept with these immutable records:

```ts
type SourceRevisionRef = {
  repoPath: string;
  sourceEv: Sha256; // full source/dependency-closure hash
  stateHash: Sha256; // exact content-addressed workspace state
};

type BuildRecipe = {
  target: string;
  platform: string;
  architecture: string;
  abi: string | null;
  options: CanonicalBuildOptions;
  toolchain: ToolchainManifestRef;
  dependencyGraph: LockedDependencyGraphRef;
};

type ExecutionArtifactRef = {
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  buildKey: Sha256;
  artifactDigest: Sha256;
  executionDigest: Sha256;
};
```

Canonical hashes are domain-separated:

- `sourceEv = SHA256("vibestudio/source-closure/v1", canonicalSourceClosure)`;
- `recipeDigest = SHA256("vibestudio/build-recipe/v1", canonicalBuildRecipe)`;
- `buildKey = SHA256("vibestudio/build-input/v1", sourceRevision,
recipeDigest)`;
- `artifactDigest = SHA256("vibestudio/artifact-bundle/v1",
canonicalArtifactManifestAndBytes)`;
- `executionDigest = SHA256("vibestudio/execution/v1", sourceRevision,
recipeDigest, buildKey, artifactDigest)`.

The exact canonical encodings are versioned and test-vector backed. Object-key
order, path separators, text encoding, symlink treatment, executable bits, and
artifact ordering are specified rather than inherited from platform behavior.
Existing 16-hex EVs may remain in display copy only; they are not accepted as an
address or principal key.

The code principal is `code:<repoPath>@<executionDigest>`. Two source revisions
that emit identical bytes remain distinguishable, and any change in source,
recipe, toolchain, dependency graph, or emitted artifact changes authority.

### R1.2 Selectors resolve to artifacts

Moving intent is represented explicitly:

```ts
type ExecutionSelector =
  | { kind: "head"; repoPath: string; head: "main" | { contextId: string } }
  | { kind: "state"; repoPath: string; stateHash: Sha256 }
  | { kind: "artifact"; executionDigest: Sha256 };
```

One host resolver accepts a selector and a canonical recipe request and returns a
verified `ExecutionArtifactRef`. It may build a missing artifact, but it never
returns a source EV as though it were executable. An exact-artifact lookup verifies
the entire record and bytes before launch.

All launch APIs accept only an `ExecutionArtifactRef`:

- `runtime.createEntity(artifact, ...)`;
- `ensureDurableObjectEntity(artifact, ...)`;
- `startWorker(artifact, ...)`;
- product-seed and bootstrap launch entries.

Name-only, EV-only, “current build,” and implicit-head launch overloads are
deleted. Common call sites first invoke the shared selector resolver. The host
rejects an artifact whose source, recipe, build key, digest, or stored bytes do not
agree.

The artifact index supports both directions needed for recovery:

- `executionDigest -> complete ExecutionArtifactRef`;
- `(sourceRevision, recipeDigest) -> buildKey and executionDigest`;
- `buildKey -> immutable build record and artifacts`.

These indexes are persisted transactionally with the artifact record; they are not
reconstructed from the current source head at launch time.

### R1.3 Logical entities and immutable incarnations

`canonicalEntityId` remains the stable logical entity identity. It owns context,
storage namespace, ownership metadata, and lifecycle. Running code is represented
separately:

```ts
type RuntimeEntity = {
  id: EntityId;
  storageNamespace: string;
  selectorPolicy: SelectorPolicy;
  adoptionPolicy: AdoptionPolicy;
  currentIncarnationId: IncarnationId | null;
};

type EntityIncarnation = {
  id: IncarnationId;
  entityId: EntityId;
  artifact: ExecutionArtifactRef;
  status: "prepared" | "active" | "retired" | "failed";
  startedAt: Timestamp;
  endedAt: Timestamp | null;
};

type UpgradeTransition = {
  id: TransitionId;
  entityId: EntityId;
  selector: ExecutionSelector;
  from: IncarnationId | null;
  to: IncarnationId;
  trigger: "launch" | "source-advanced" | "manual-repin" | "rollback";
  actor: AuthorizationSubject;
  status: "preparing" | "awaiting-adoption" | "committed" | "failed" | "cancelled";
  error: StructuredError | null;
  createdAt: Timestamp;
  committedAt: Timestamp | null;
};
```

An upgrade prepares and verifies the artifact, creates the new incarnation, invokes
the surface-specific adoption adapter, and atomically commits the current pointer
plus transition result when that adapter reaches its adoption boundary. A queued
user action remains `awaiting-adoption`; the old incarnation stays authoritative
until the action succeeds. Superseded candidates are explicitly cancelled. A
failure leaves the old incarnation authoritative and records a structured, visible
error. Recovery is idempotent at every boundary. There is no interval in which the
entity row claims code that the runtime did not adopt.

An incarnation is an audit identity, not a demand to restart a process. For dynamic
workerd loading, a committed incarnation advances the loader generation while the
workerd process stays alive. Runtime entities use incarnation rows; non-entity
surfaces such as apps and panels keep exact active/candidate artifact refs and the
same transition states in their native registry instead of manufacturing fake
entities. Surface adapters implement the R0 contracts.

For client-loaded code, the server distinguishes “available from the host” from
“loaded by this client session.” Each panel/app session binds the execution digest
it actually loaded for identity and provenance. Cache invalidation or update
availability never lets the server claim that an already loaded client adopted new
code.

Durable Object storage belongs to the logical entity. Code adoption never creates
a new storage namespace. In-flight work, in-memory objects, alarms, WebSockets, and
bearer credentials follow their captured R0 behavior; they are not reset merely
because the data model now calls the code change an incarnation.

### R1.4 Selection and adoption policies

Do not use one global `follow-head` boolean. Store two explicit policies:

- `SelectorPolicy`: main head, named context head, exact state, or exact artifact;
- `AdoptionPolicy`: the surface-specific boundary defined by the R0 ledger, such
  as next request, cache invalidation, queued user action, mobile install, or
  process restart.

Only main/context selectors react to their matching source-advance event. Exact
state and exact artifact selectors are pinned. A manual repin and rollback are
attributed transitions using the same machinery, not side doors.

The transition event includes logical entity, old and new execution digest,
selector, build recipe digest, actor, trigger, outcome, and user-visible adoption
state. Existing EV/build-key fields remain in UI payloads only where product copy
needs them, sourced from the exact artifact record.

### R1.5 Product benefits without special cases

- Reproducible spawn: a child records and launches the artifact it selected.
- Provenance: every effect names the exact execution digest and entity incarnation.
- Rollback: an existing retained artifact becomes a new attributed incarnation.
- A/B: two logical entities may intentionally select different exact artifacts.
- System Agent: its blessed code is an ordinary exact artifact above the bootstrap
  root, with exact grants in R3.

### R1.6 R1 deletion and acceptance gate

Delete all name-only/EV-only launch signatures, mutable code refs on entity rows,
implicit runtime-image head resolution, and truncated-hash lookup. Migrate every R0
launch row in the same tranche.

R1 passes when exact launch, head adoption, context isolation, state/artifact pins,
rollback, failed upgrade, crash recovery, provenance, and every surface parity
fixture pass with no parallel entity or launch path.

## R2. Hermetic build recipes, artifact storage, and retention

R1 identity is trustworthy only if all inputs are sealed and historical output can
be verified. Moving a root fingerprint into workspace state is insufficient: live
`node_modules`, builder code, plugins, environment, target platform, ABI, and
registry resolution can all change output.

### R2.1 Sealed build recipe

`BuildRecipe` captures every output-affecting input:

- builder and plugin code by content digest;
- esbuild/compiler/runtime versions and configuration;
- target, platform, architecture, ABI, source-map mode, defines, conditions,
  loaders, minification, and canonical environment allowlist;
- product host package/lock/workspace/tsconfig inputs required by the builder;
- the complete locked external dependency graph, package integrity hashes, and
  content-addressed package blobs;
- all generated templates or product seed assets used by the build.

Product/toolchain inputs belong in a sealed product build manifest, not in the
user's source EV. A host/toolchain update changes `recipeDigest` and therefore
`executionDigest` without pretending the user's source changed.

No historical build resolves `latest`, `*`, a semver range, mutable tag, or registry
metadata. Such declarations are resolved once into the locked dependency graph;
the resolver records exact versions, integrity, graph edges, registry provenance,
and blobs before the recipe becomes buildable. Historical rebuild consumes only
that graph and the content store, even with the registry unavailable.

Undeclared environment reads, live repository files, global tools, network access,
and ambient `node_modules` are build failures. Platform data is included precisely
when it can affect output, rather than hidden in a cache namespace.

### R2.2 Canonical artifacts and verification

A build writes an immutable artifact bundle containing a canonical manifest and
all emitted bytes. The manifest records paths, sizes, modes, content types,
per-file digests, source revision, recipe digest, and build key. The aggregate
artifact digest covers the manifest and bytes.

Artifact bytes are verified when they enter the content store and when they cross a
persistence/trust boundary. A verified immutable store handle may cache that result
under the store's integrity epoch; ordinary requests do not rehash a large bundle
on every dispatch. Cache lookup and launch still verify the complete record/handle
binding. Missing, corrupted, or mismatched artifacts fail closed with a diagnostic
that identifies the digest and failing component; the runtime never falls back to
building “whatever is current.” Periodic scrubbing and tamper tests validate the
store without moving unbounded hashing cost into user interactions.

### R2.3 Authoritative roots and mark-and-sweep

Retention uses mark-and-sweep over immutable records, not increment/decrement
reference counters. Roots are read from their owning stores:

- active and deliberately retained entity incarnations;
- exact state/artifact selector policies and rollback history;
- preparing or unresolved upgrade transitions;
- installed/queued app versions and their rollback records;
- exact code-principal grants and reusable delegation policies;
- bootstrap and product-seed manifests;
- active builds, leases, exports, and diagnostics explicitly retained by policy.

Marking traverses the complete closure: execution artifact, artifact bytes, build
record, recipe, toolchain and plugin manifests, locked dependency graph and blobs,
source revision, and workspace state/tree.

Sweep is epoch-based and crash-safe. A candidate must be unmarked across the
configured grace epochs; unresolved transitions and active leases are never swept.
Deletion is idempotent, records a tombstone/audit result, and cannot make a marked
record unreachable. Dry-run and explain modes show which root retains an artifact
or why it is eligible. A failed sweep resumes without trusting partial counters.

Code grants root their exact artifact while the grant is reusable. Revoking the
grant removes that root, but other roots and grace epochs still apply.

### R2.4 R2 deletion and acceptance gate

Delete live-disk root fingerprints, mutable-registry historical resolution,
unverified artifact cache hits, truncated build keys, and the current runtime-image
retention logic that can only reason about current names.

R2 passes when the same revision and recipe reproduce the same artifact in a clean
environment after caches are removed and registry/network access is disabled;
platform differences are either captured in the recipe or proven irrelevant;
tampering is rejected; pinned recovery works after head advancement and GC; and
fault-injected mark/sweep cannot delete a rooted closure.

## RB. Minimal bootstrap trust root and ordinary product seeds

“Every internal DO is ordinary” cannot be literally true below the services that
create entities and resolve grants. Define one generic, minimal bootstrap root
instead of preserving per-class exceptions.

### RB.1 Product boot manifest

The host distribution contains a sealed, content-addressed product boot manifest
bound to the full product build digest. It lists only the artifacts, bindings, and
minimum capabilities required to establish:

1. content/source/build record access needed for exact launch;
2. the entity/WorkspaceDO substrate;
3. authorization and grant resolution;
4. the minimal context-binding mechanism required by those services.

R0's dependency graph decides the exact set. Entries are artifact refs with
explicit bootstrap bindings and method-scoped capabilities; they are not class
names with magic environment injection. The host bootloader verifies the product
digest, manifest, artifact closure, and bindings before start. Bootstrap authority
cannot be modified by userland and changes only with a new product build.

The host principal is `host:<productBuildDigest>`. Bootstrap actions are attributed
to that principal and constrained by the boot manifest. “Server” is not a wildcard
caller identity.

### RB.2 Ordinary units above the root

Once the substrate exists, EvalDO, VCS store, browser data, webhook handlers,
System Agent, and other product units launch through R1 as exact product-seed
artifacts and receive R3 grants like any other code. Context binding remains a
launch attribute; permission to create a main-bound entity is a declared host/code
capability plus relationship, not a hardcoded class list.

Delete `getInternalDoEnv`, `isBootstrapMainBoundDo`,
`getBootstrapMainBoundDos`, parallel internal registration, ambient lifetime
secrets, and per-class source shortcuts only after the manifest covers their real
dependencies. No new bootstrap entry is accepted unless placing it above the root
would be circular and the R0 graph demonstrates that fact.

### RB.3 Bootstrap acceptance gate

Test a clean boot, product update, manifest/artifact tampering, missing boot entry,
grant-store recovery, and startup interruption at each dependency boundary. The
system must either establish the verified substrate or stop with an actionable
diagnostic; it never silently starts a privileged unit outside the manifest.

## R3. Compositional capability trust

R3 has two sequential checkpoints on one final architecture. R3A replaces the
mechanism with exact behavioral parity. R3B performs deliberate policy review and
tightening. This separation is not a compatibility path: R3A deletes the old
mechanism; R3B edits policies on the new mechanism.

### R3.1 Principals and authenticated facts

Principals are non-interchangeable:

- `user:<id>` — an authenticated human/account subject;
- `device:<id>` — a registered device, related live to its owning user;
- `code:<repoPath>@<executionDigest>` — host-verified exact code;
- `entity:<entityId>` — the stable logical runtime identity; the host separately
  binds each call to its active incarnation and exact code principal;
- `host:<productBuildDigest>` — the minimal product/bootstrap principal.

Agent identity is a verified binding or relationship on an entity, not a caller
string supplied by code. Owner/deputy lineage and acting user are preserved as
separate facts; they do not become aliases for the code principal.

Every dispatch constructs an `AuthorizationContext` from authenticated transport
and host/runtime records:

```ts
type AuthorizationContext = {
  host: HostPrincipal | null;
  actingUser: UserPrincipal | null;
  device: DevicePrincipal | null;
  entity: EntityPrincipal | null;
  incarnation: IncarnationId | null;
  code: CodePrincipal | null;
  ownerChain: readonly Principal[];
  agentBinding: AgentBinding | null;
  delegation: readonly VerifiedDelegation[];
  workspace: LiveWorkspaceRelationship | null;
  session: VerifiedSession;
};
```

Runtime kind may be carried separately for schema/routing. None of these fields is
trusted from client arguments. The gateway/host resolves and binds them; direct DO
relay preserves them through a host-attested, audience-bound, short-lived,
attenuated invocation token or an equivalent host mediation. The token is not a
bearer grant to arbitrary methods and cannot add facts during forwarding.

`host` is non-null only when the host itself originated the operation under the
boot/product manifest. Merely authenticating, relaying, or serving an untrusted
request does not lend that request the host principal.

Membership, roles, device ownership, grants, denials, delegation validity, and
entity/incarnation binding are resolved live at dispatch. Long-lived WebSockets or
runtime connections do not cache an authorization snapshot across revocation.
Revision-keyed caches are allowed when invalidation/revision checks guarantee the
same next-dispatch semantics; “live” does not require a blocking database read on
every method call.

### R3.2 Requested capabilities, grants, and denials

All unit manifests declare requested capabilities. Effective code authority is:

```text
manifest request ∩ applicable grants ∩ delegation attenuation − explicit denies
```

Manifest expansion never activates a pre-existing broad grant automatically. A
new requested capability or broader resource scope enters the existing approval
flow. Manifest removal attenuates immediately. Denies take precedence at every
level and revocation is visible on the next dispatch.

The grant store records subject, capability, resource scope, constraints, issuer,
approval/audit provenance, created/revoked time, and binding policy. A code grant
subject is either an exact execution digest or an explicit `(repoPath, selector)`
lineage. The latter is not another code identity: dispatch still authenticates an
exact code principal, then proves that artifact is the current verified resolution
of the grant's selector.

Privileged code grants default to an exact execution digest. Selector-bound grants
are allowed only per capability and resource when the new manifest requests an
equal-or-narrower scope. R3A creates them solely where the R0 ledger proves today's
approval/grant already survives routine updates on that selector; this preserves
current no-reprompt behavior without granting unrelated heads or artifacts. R3B
reviews every such binding and may tighten it. There is no blanket “follow-head
grants.”

User, device, code, entity, and host grants are queried separately. Their sets are
never unioned to answer a compound request.

### R3.3 Declarative requirement algebra

Every callable method declares a structured requirement with canonical resource
derivation. The minimal algebra supports:

- `capability(principalKind, name, resourceFromRequest)`;
- `allOf(...)` and `anyOf(...)`;
- live relations such as workspace member/role, device owned by acting user,
  entity self, entity owner/deputy, channel owner/editor/member, agent binding, and
  delegation audience/purpose;
- session/version/scope constraints and explicit deny evaluation.

Examples:

- A code-originated filesystem write requires the exact code principal's
  `fs.write` grant **and** the acting user's live admission to that workspace.
- A host administration action requires a live user role and its named capability;
  a code grant cannot manufacture the role.
- A device-scoped operation requires both the device capability and the live
  relation that the device belongs to the acting user.
- An entity mutation requires the appropriate code/user capability and a live
  self/owner/deputy relation to the target entity.
- EvalDO calling on behalf of System Agent preserves acting user, exact EvalDO
  code, exact agent entity/code, owner lineage, and delegation. The policy names
  which facts must each authorize; no confused-deputy union is possible.

Resource keys are derived by canonical schema-owned functions from validated
arguments and authoritative records, not ad hoc service strings or client-claimed
owners. Existing resource scope, session, version, and deny semantics remain part
of the declaration.

### R3.4 One contract on both RPC planes

Host service dispatch and direct WorkspaceDO RPC use the same
`AuthorizationContext`, requirement evaluator, capability registry, resource-key
derivers, error taxonomy, audit event, and revocation behavior.

- `serviceSchemas` methods declare the requirement directly.
- `@rpc` methods reference the same requirement form; default deny remains.
- Relays propagate only host-attested, audience-bound facts.
- Owning services remain authoritative for relationships and resource state.
- Method registration fails if no requirement is declared.

Delete caller-kind allowlists only after the corresponding method has a complete
default-deny declaration on the new evaluator. Then delete
`authenticatedCallerOf` code-identity loss, `isTrustedWorkspaceCaller`,
`isAuthorizedChrome`, service-local privilege branches, and `@rpc({callers})` as
authorization. A kind check may remain only where the R0 ledger marks it as input
shape/routing and a test proves it grants no authority.

### R3A. Exact behavioral cutover

Transcribe the R0 authority ledger to the new requirements and grants. For every
row, the same authenticated scenario must produce the same allow, deny, approval,
prompt text/resource/scope, error class, and visible recovery behavior. R3A adds no
new prompt, denial, broader grant persistence, or owner-only restriction. Explicit
selector-bound grants reproduce only persistence already present in the R0 ledger.

R3A is complete when:

- the generated method census and ledger match with no omissions;
- before/after parity tests pass for every method class on both RPC planes;
- spoofed client facts, stale grants, revoked membership, wrong audience, and
  altered execution digests fail;
- multi-principal/confused-deputy tests prove requirements are intersected;
- the old authorization mechanisms and grant representations are deleted;
- all approval and audit UI reads the new canonical capability/resource records
  without changing its product behavior.

### R3B. Enumerated policy review and tightening

After R3A passes, review every transcribed policy. Each intended change is one
ledger entry containing:

- old and new rule;
- threat or product rationale;
- affected users, surfaces, and workflows;
- prompt/denial/recovery UX;
- exact-grant versus selector-inheritance decision;
- rollout/reset consequence for this pre-release codebase;
- positive, negative, revocation, and delegation tests;
- explicit acceptance.

R3B may be ambitious, including least-privilege product-seed grants and removal of
unnecessary ambient access. It may not hide a product decision inside a mechanical
refactor. Unchanged rows retain R3A behavior. R3 is not done until every row is
either explicitly unchanged or has an accepted R3B entry; there is no unreviewed
“temporary broad profile.”

## R4. Explicit channel creation, admission, and presentation

R4 lands after the R3 authority substrate because channel administration depends
on exact principals and compound relationships. Its schema may be designed in
parallel, but it must not create a second authority evaluator.

### R4.1 Separate concepts

```ts
type Channel = {
  channelId: ChannelId;
  currentStructureRevision: ChannelStructureRevisionId;
};

type ChannelStructureRevision = {
  id: ChannelStructureRevisionId;
  channelId: ChannelId;
  predecessor: ChannelStructureRevisionId | null;
  createdBy: AuthorizationSubject;
  createdAt: Timestamp;
  reason: ChannelStructureTransitionReason;
  owner: Principal;
  contextBinding: ContextBinding;
  origin: ChannelOrigin;
  admission:
    | { kind: "workspace-members" }
    | { kind: "channel-members" }
    | { kind: "principals"; allow: readonly PrincipalPattern[] };
  presentationEditors: PresentationEditorPolicy;
};

type ChannelPresentation = {
  title: string;
  approvalLevel: ApprovalLevel;
  conversationPolicy: ConversationPolicy;
  // Other mutable, non-authority UI fields from the R0 ledger.
};
```

Use exact semantic names; do not introduce a vague `open` mode. A truly public
mode is added only if a concrete product workflow requires and specifies it.

- Each structure revision is immutable. Explicit structural lifecycle operations
  append a successor and atomically advance the channel's current revision; they
  are never disguised as presentation updates. Context/origin changes require a
  fork with a new channel ID because they change the channel's identity boundary.
- Admission controls who may subscribe.
- `channel_members` continues to represent invitations/discovery/presence for
  ordinary workspace channels unless the channel was explicitly created with
  `admission.kind = "channel-members"`.
- Presentation is mutable under the editor policy and R3 requirements.
- Owner, admitted participant, invited member, visible user, and presentation
  editor are distinct relationships.

### R4.2 Explicit creation and mutation

A generic userland channel factory performs one atomic `createChannel(structure,
presentation)` operation under R3 authorization. It records the creator, first
structure revision, presentation, and current-revision pointer. `subscribe` never
creates or initializes authority.

Creation is idempotent only when the full canonical creation record matches. A
same-ID/different-structure request is a conflict, not “first writer wins.” Failed
creation leaves no subscribable partial channel.

Presentation updates require the declared editor relationship plus the named
capability and preserve current optimistic/version/error behavior from R0. Normal
collaborating users who can edit today continue to edit after R4; migration does
not silently reduce normal channels to owner-only.

The host provides generic storage/lifecycle/enforcement primitives. Product
features choose structure in userland; the host does not learn System Agent,
conversation, panel, or feature-specific channel semantics.

### R4.3 Normal workspace parity

Existing normal channels are recreated with
`admission: { kind: "workspace-members" }`. Invitations and `channel_members`
retain their current discovery/roster role. Multi-human subscribe, presence,
reconnect, invitation, visibility, presentation editing, and deletion must match
the R0 fixtures.

For a user-created channel, the owner is the authenticated user who performs the
existing creation action—not the first subscriber and not the hosting process.
Workspace/product-created channels name their owner relationship explicitly in the
R0 ledger. Their presentation-editor policy preserves the current collaborating
workspace members or roles rather than defaulting to owner-only.

If a feature wants a member-gated private channel, it must explicitly create one
with `admission.kind = "channel-members"`; the refactor does not reinterpret all
existing rosters as ACLs.

### R4.4 Transfer, fork, clone, deletion, and recovery

Because structure revisions are immutable, lifecycle operations have exact rules:

- **Owner transfer:** an atomic, attributed operation creates the successor
  revision under an expected-current-revision precondition after current-owner and
  recipient checks. The stable channel ID and history remain; no period has zero or
  two authoritative owners.
- **Admission/editor change:** an explicitly authorized structural transition
  appends a complete replacement revision. Locked channels require an independent
  administrative capability; ordinary presentation-edit authority is insufficient.
- **Fork/clone:** creates a new channel ID. It explicitly chooses the new owner,
  rewrites context binding, copies or resets presentation, and copies invitations
  only when the feature contract requests it. Authority is never inherited by
  accident.
- **Owner revoked/deleted:** follows the R0 workspace recovery policy. Any admin
  recovery requires a named R3 capability plus live workspace role and is audited.
- **Deletion:** requires owner/admin relationship, is idempotent, revokes future
  subscriptions, and preserves the existing visible deletion/reconnect outcome.
- **Concurrent editing:** preserves existing version/conflict behavior; R4 does not
  replace it with last-writer ownership semantics.

### R4.5 Locked System Agent channel

The System Agent channel is an ordinary channel with deliberately narrow structure:

- owner: the user principal;
- admission: the exact user plus the stable agent entity bound to that user;
- context/origin: explicit System Agent values chosen by its userland factory;
- presentation editors: the exact intended owner/agent relation from the R0
  contract.

Subscription by the entity additionally requires its current incarnation's exact
code principal to hold the channel-scoped join capability and to satisfy the
verified agent binding. A product-seed code update can therefore preserve the
stable entity relationship while still rejecting drifted code; exact or
selector-bound grant persistence follows its R3A/R3B ledger entry. EvalDO or other
deputies enter only through the full verified entity/code/agent/delegation chain; a
caller label cannot impersonate the agent. Changing the locked structure requires
an independent, explicit administrative authority and creates an audited successor
revision—it is not a presentation update.

### R4.6 R4 deletion and acceptance gate

Delete first-subscribe initialization, open `ChannelConfig` authority fields,
panel/server caller-kind mutation gates, and feature-specific host channel
shortcuts. R4 passes normal multi-human parity tests plus exact-admission denial,
invitation/discovery distinction, presentation editing, conflict, transfer,
fork/clone, deletion, owner recovery, System Agent, and spoofed-principal tests.

## 2. Delivery sequence and tranche boundaries

The work lands in this order:

1. **R0 — contracts and censuses.** Check in the execution/update, authority,
   channel, and bootstrap ledgers plus parity fixtures. This is the implementation
   gate.
2. **R2 identity/storage foundation.** Introduce full canonical hashes, sealed
   build recipes, immutable artifact records, indexes, and mark/sweep. Switch the
   build system completely and delete live-input historical paths.
3. **RB bootstrap root.** Establish the minimal product boot manifest and verified
   host principal needed for the following runtime migration.
4. **R1 entities and adoption.** Switch every launcher to exact artifact refs,
   introduce logical entities/incarnations/transitions, and preserve each R0
   adoption contract. Delete old launch and runtime-image paths.
5. **R3A authority parity.** Build and test the evaluator without making it a
   second live gate, then switch every host service and direct-DO method in one
   repository cutover. Delete all old authorization forms in that cutover.
6. **R3B policy review.** Apply only enumerated, accepted security/product changes.
7. **R4 channels.** Move explicit creation and structural policy onto R3, preserve
   ordinary workspace UX, then add the locked System Agent channel form.
8. **Product-seed completion and related-plan rebase.** Move every unit above the
   bootstrap root to ordinary exact launch/grants and rebase SA0 and related docs.

R2 precedes R1 because exact execution should not be installed on a known
best-effort historical build substrate. R4 follows R3 because channel policy needs
the shared principal and relationship algebra. Design and fixture work may proceed
in parallel, but no released boundary contains dual execution or authorization
semantics.

Each tranche is independently compilable, testable, and conceptually complete.
If a call site cannot fit its new abstraction, stop and correct the abstraction;
do not add an overload, exception list, fallback resolver, shadow store, or second
identity channel.

## 3. State and cutover policy

Runtime-foundation schemas receive a new pre-release format version. Old entity,
runtime-image, artifact-cache, grant, and channel-foundation records are not read by
the new runtime. Derived local runtime state is reset at the tranche boundary with
an explicit diagnostic and scoped reset command; workspace source/content remains
untouched. The plan does not promise compatibility for active pre-release runtime
sessions or foundation metadata.

The reset is itself a specified one-time UX, not a silent implementation detail.
Startup names the incompatible format, lists the categories that will be reset,
keeps source/content out of scope, and requires the explicit scoped reset. Product
seed state is regenerated from the verified product manifest. User approvals,
active sessions, runtime entities, queued updates, and ephemeral channel state may
need to be recreated after this declared pre-release cut; release notes and the
diagnostic say so plainly. Steady-state parity tests begin from equivalent new-format
state and prohibit repeated prompts or workflow changes thereafter.

All call sites and checked-in product seeds migrate in the same change as their
schema. Startup refuses mixed versions instead of guessing or silently rebuilding
from head. This deliberate data cut is distinct from product behavior: after a
clean start, the parity ledgers still govern workflows, prompts, collaboration,
update timing, and failure recovery.

## 4. Verification program

### 4.1 Identity and hermeticity

- Canonicalization test vectors on Linux and every supported target platform.
- Property tests that any source, state, recipe, dependency, toolchain, option, or
  output-byte change alters the appropriate full digest.
- Clean rebuild after deleting caches and disabling registry/network access.
- Historical rebuild after main/context heads advance.
- Artifact and index tamper tests; short-hash inputs are rejected.
- Cross-target/platform/ABI tests proving recipe separation.
- R0 launch/start/update latency budgets prove integrity work did not move an
  unbounded hash, network fetch, or dependency install into an interaction path.

### 4.2 Entity lifecycle and UX parity

- Main and context selector advancement; unrelated heads do nothing.
- State/exact pins survive rebuild, restart, and GC.
- Crash injection before artifact preparation, after preparation, before pointer
  commit, after pointer commit, and during old-incarnation retirement.
- Failed adoption keeps the old artifact authoritative and preserves rollback.
- Worker/DO next-request loading occurs with no workerd restart or concurrent-work
  termination.
- DO storage, in-memory instance, alarm, hibernation, WebSocket, route/class
  reconciliation, and bearer-token behavior matches R0.
- Panel cache invalidation does not force reload/navigation.
- Electron “Load update,” React Native install availability, terminal lifecycle,
  app error notification, and rollback match current copy and timing.
- Every extension/other runtime-kind row has an executed parity fixture.

### 4.3 Authorization

- Generated census ensures every host and direct-DO RPC method has a declaration.
- R3A before/after allow, deny, approval, error, and prompt parity per ledger row.
- Same requirement result and audit event on both RPC planes.
- Spoofed user/device/code/entity/owner/agent/delegation facts fail.
- Wrong artifact digest, stale incarnation, wrong token audience, replay, expiry,
  membership revocation, grant revocation, deny precedence, and manifest removal
  take effect at the specified next-dispatch boundary.
- Confused-deputy matrices cover user × device × code × entity × owner/deputy ×
  delegation without union escalation.
- Selector-bound grants work only for an individually documented R3A parity rule
  or accepted R3B entry and never broaden beyond the new manifest request.
- R3B tests map one-to-one to accepted policy changes; no unrelated snapshot drifts.

### 4.4 Channels

- Creation is atomic; first subscribe cannot seize structure.
- Ordinary workspace-member admission, invitation/discovery, presence, reconnect,
  presentation editing, and multi-human collaboration retain parity.
- Explicit member-gated and exact-principal channels enforce their chosen policy.
- Transfer, fork/clone, context rewrite, owner loss, admin recovery, concurrent
  edit, deletion, and reconnect have deterministic tested outcomes.
- System Agent admits only its exact intended principal chain and rejects drifted
  code, caller-label spoofing, and unrelated workspace members where locked policy
  excludes them.

### 4.5 Retention and bootstrap

- Every root kind retains its complete source/recipe/dependency/artifact closure.
- Grace epochs, dry-run explanations, concurrent roots, revocation, interrupted
  mark, interrupted sweep, and idempotent resume are fault-injected.
- A pinned artifact and its grants survive restart and sweep; an unrooted closure
  eventually disappears.
- Clean bootstrap, product update, missing/corrupt boot manifest, corrupt artifact,
  grant-store recovery, and circular-dependency detection are covered.
- No privileged product unit can start through an unmanifested path.

### 4.6 Repository verification flow

For each tranche, run the smallest focused unit/integration suites and type checks
first. Then use the repository's headless system-test procedure: doctor, discover
exact test names, run the smallest relevant exact tests, inspect every non-zero
run, repair the root cause, rerun, then expand to the category and smoke coverage.
An agentic failure is investigated through its trajectory and diagnostics; it is
not dismissed as a prompt issue or reported only as an artifact path.

## 5. Definition of done

The refactor is complete only when all of the following are true:

- R0 ledgers and method/launch censuses have no missing or unknown rows.
- No launch accepts a name, moving selector, EV, short hash, or unverified build as
  executable identity.
- No build depends on undeclared live disk, registry, network, environment, or
  toolchain state.
- Entity code history is append-only and every current pointer change is an
  attributed, recoverable transition.
- Every R0 adoption and UX fixture passes; no new reload, restart, navigation,
  prompt, denial, or owner-only restriction appeared unintentionally.
- Both RPC planes use one authority context, evaluator, resource derivation model,
  denial order, audit model, and revocation boundary.
- Caller kind appears only in documented shape/routing sites and cannot increase
  authority.
- Every R3B security change is enumerated, accepted, and directly tested; every
  other policy retains R3A parity.
- Ordinary channels retain WP7 multi-human behavior, while exact locked channels
  are expressible without feature-specific host logic.
- The bootstrap root is minimal and graph-justified; all other product units are
  ordinary exact artifacts with explicit grants.
- Mark-and-sweep can explain every retained artifact and safely removes unrooted
  closures after grace.
- Old launch overloads, mutable entity code refs, live-input build paths, reference
  counters, internal-DO exceptions, ambient privilege injection, caller-kind
  authorization, first-subscribe channel creation, and old foundation schemas are
  deleted.
- Related plans are rebased on these final primitives and no longer describe
  bespoke blessed-EV, trust, or channel mechanisms.

The System Agent SA0 plan then reduces to genuinely product-specific work: an
ordinary product-seed unit and exact artifact, explicit grants, an explicitly
created locked channel, conversation registry, `spawnDebug`, card schemas, and UI.
It does not carry private execution, authorization, bootstrap, or channel paths.

# Exact-state static validation of userland service authority

Related proposal (2026-09-17): [Holistic authority and capability static checking](holistic-authority-static-checking-plan.md) extends this exact-state design to implementation effects, credential prerequisites, transport conformance, agent calls, and compatibility. It preserves this document's immutable-input and atomic-revalidation rules; its implementation inventory distinguishes existing code from proposed work.

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Exact-state analysis remains subordinate detail. Static declarations and generated findings do not confer OS authority.

Status: implementation plan, revision 3 (2026-08-01). Revision 2 incorporated
the access-control, opaque-handle, total-resolution, analysis-epoch,
package-provenance, state-independent-catalog, and complete-baseline findings
from the first design review. Revision 3 separates provider-independent call
facts from provider-derived handles, includes external executable dependency
bytes, defines service-operation resources, completes opaque-handle receiver
identity, seals service presentation into exact bindings, and specifies atomic
candidate-index promotion.

Depends on:

- `docs/explicit-capability-manifest-plan.md` for the rule that installed-code
  authority is an explicit, review-visible source contract;
- `docs/userland-gad-capabilities-prerequisite-plan.md` for receiver-owned
  userland capability definitions, canonical definition identities, resource
  handles, and runtime enforcement;
- `docs/authority-acquisition-spec.md` and
  `docs/authority-p1-enforcement-spec.md` for grants, acquisition, invocation
  attestation, and receiver-side enforcement.

This plan owns one missing build-time contract: method-level static validation
for consumers of workspace-authored services, including deterministic
revalidation when the provider changes. It does not change runtime
authorization, approval policy, or the meaning of a manifest request.

## 0. Decision

The exact-state build report will derive the userland authority effects used by
installed code and compare them with the consumer's explicit
`vibestudio.authority.requests`.

For a consumer at workspace state `S`, the authority result is a deterministic
function of four immutable inputs:

```text
consumer source closure at S
+ workspace service declarations at S
+ sealed RPC catalogs of referenced providers at S
+ consumer authority manifest at S
```

Changing any input invalidates the authority result. In particular, changing a
provider's RPC decorator, provided capability definition, protocol binding, or
resource selector rechecks unchanged consumers before protected `main` may
advance.

This remains static review validation, not an authorization oracle. The
receiver's live, exact-build declaration is the runtime enforcement boundary.
The build never grants authority, edits a manifest, or treats inferred use as
consent.

## 1. The gap

The current exact-state authority fold handles host services in useful detail:
it recognizes public runtime facades and typed clients, maps concrete host
methods through the generated host authority catalog, closes over declared
method prerequisites, and reports missing semantic manifest requests.

For userland services it currently stops at service admission. A literal
protocol such as `vibestudio.channel.v1` can produce:

```text
workspace-service:channel
```

but the consumer call below does not yet statically produce the provider-owned
method capability:

```ts
const channel = await workers.resolveService("vibestudio.channel.v1", channelId);
await rpc.call(channel.targetId, "removeMember", [memberId]);
```

The provider already declares and seals that method's effect:

```ts
@rpc({
  principals: ["code"],
  effect: {
    kind: "userland-capability",
    capability: "channel.members.remove",
    resource: { kind: "receiver-object" },
  },
  tier: "critical",
  sensitivity: "destructive",
})
```

and the build already derives an immutable identity such as:

```text
userland:workers/pubsub-channel/channel.members.remove#<definition-digest>
```

Runtime dispatch enforces that identity. The missing piece is to connect the
consumer's resolved service and method call to this sealed provider catalog in
the build report, and to preserve that connection across provider updates.

Without provider-aware invalidation, a checker can appear correct while going
stale: a method may change from open to protected, or bind to a different
capability, without touching the caller's files. That is the primary failure
this plan prevents.

## 2. Required invariants

### I1. Exact-state coherence

Consumer source, service declarations, provider source, provider manifest, and
RPC schema adapters must all come from one immutable workspace state. A report
must never combine candidate consumer bytes with a currently active provider
build or mutable checkout configuration.

### I2. One provider declaration

The existing `@rpc` / `@schemaRpc` declaration and
`vibestudio.authority.provides` remain the only provider-owned sources of
method authority. Static validation consumes the same sealed catalog used for
live discovery and runtime receiver resolution. There is no consumer-side
method table and no handwritten protocol-to-capability map.

### I3. Explicit consumer intent

Inference may diagnose or propose a manifest edit. It may not write the edit,
grant it, downgrade its tier, or broaden its resource scope. The review-visible
manifest mismatch is the point of the mechanism.

### I4. Provider changes revalidate consumers

An unchanged consumer is affected when a referenced provider's authority
catalog changes. Candidate and published dependency views are both considered
so removed protocols, renamed services, deleted methods, and deleted providers
cannot disappear from validation.

### I5. No package-DAG distortion

Userland service relationships are authority-analysis dependencies, not module
dependencies. They must not be inserted into `PackageGraph`: two services may
legitimately call each other, while the package graph must remain acyclic for
build ordering.

### I6. No startup tax

Server startup, panel opening, and first chat activation do not eagerly scan or
build all userland providers. Provider catalogs and consumer summaries are
derived lazily for build reports and protected publication, single-flighted,
and cached by immutable inputs.

### I7. Dynamic code is bounded honestly

Finite dynamic choices are expanded. A known service with an unbounded method
requires the protected effects of every method it could reach. A service whose
identity cannot be bounded produces an actionable diagnostic; the checker does
not silently infer nothing and does not demand every service in the workspace.

### I8. Runtime enforcement remains load-bearing

Static analysis makes installed-code intent legible and catches drift. It is
not claimed to prove arbitrary JavaScript behavior. Computed dispatch,
reflection, dynamically loaded code, and escaped transport objects remain
contained by sealed runtime endowments and receiver-side authority checks.

## 3. Existing components to reuse

The design deliberately composes existing mechanisms:

| Existing component | Role in this plan |
| --- | --- |
| `src/server/buildV2/workspaceRpcCatalog.ts` | Extracts exact provider methods and seals userland capability definitions. |
| `src/server/buildV2/workspaceRpcSchemas.ts` | Supplies typed schemas for provider classes that opt into a known RPC schema. |
| `src/server/buildV2/typecheckFold.ts` | Owns the exact TypeScript `Program` used for build feedback. |
| `src/server/buildV2/authorityFold.ts` | Compares inferred installed-code effects with the manifest. |
| `src/server/buildV2/index.ts` | Produces build reports and computes protected-publication affected units. |
| `packages/shared/src/authorityManifest.ts` | Parses requests, provider definitions, wildcard families, tiers, and resource scopes. |
| `packages/shared/src/unitAuthorityInference.mjs` | Shared inference entry used by checkout auditing and exact-state builds. |
| `scripts/generate-unit-authority-manifests.mjs` | Offline proposal/audit path; never runs as an authority-granting build mutation. |

`workspaceRpcCatalog` currently describes itself as discovery-only and not an
authority input. That remains correct for runtime authorization: catalog data
does not grant or attest a call. Its exact sealed projection will additionally
become a static diagnostic input. Comments and types must distinguish those two
uses precisely.

## 4. Conceptual pipeline

```text
                         exact workspace state S
                                  |
                +-----------------+------------------+
                |                                    |
        consumer TS Program                  service declarations
                |                                    |
        consumer call summary               protocol/name -> provider
                |                                    |
                +---------------+--------------------+
                                |
                  exact provider catalog resolver
                                |
              method -> open | sealed userland effect
                                |
                    required authority effects
                                |
             compare with consumer manifest requests
                                |
              ordinary BuildDiagnostic(source=authority)
                                |
          existing build report / protected-main build gate
```

There is one outward-facing result and one publication gate. The new analysis
does not introduce a second validator, approval path, or feedback channel.

## 5. Data model

### 5.1 Exact service binding

The build system currently receives only service names and protocols. Extend
that exact-state input to include the provider identity needed to locate the
catalog:

```ts
interface ExactWorkspaceServiceBinding {
  name: string;
  protocols: readonly string[];
  source: string;
  title?: string;
  action: string;
  description?: string;
  presentation: {
    domain: "files" | "sharing" | "accounts" | "web" | "automation" | "people" | "computer";
    verb: "see" | "act" | "manage";
    substanceKind?: "change-set" | "send" | "deletion" | "custom";
  };
  principals: readonly ("host" | "user" | "code" | "session" | "mission")[];
  target:
    | { kind: "durable-object"; className: string; defaultObjectKey: string | null }
    | { kind: "worker"; routePath: string };
}
```

The callback should be renamed from the narrow `workspaceServicesAt` shape to
an exact-state authority environment, for example:

```ts
workspaceAuthorityEnvironmentAt(stateHash): Promise<{
  services: readonly ExactWorkspaceServiceBinding[];
}>;
```

The server continues to derive it from
`loadWorkspaceConfigFromState(stateHash)`. The build system must not read the
mutable live workspace configuration itself.

Stateless route services have only service-level admission unless and until
they expose a receiver method contract. Durable Object services additionally
resolve method-level RPC authority from the provider class catalog.

### 5.2 Provider catalog projection

The full documentation catalog contains presentation and signature data. The
authority analyzer consumes a smaller immutable projection. The catalog is
state-independent and content-addressed; the exact workspace state belongs to
the service resolution that selects the catalog, not to the reusable catalog
itself:

```ts
interface UserlandServiceAuthorityCatalog {
  provider: {
    unitName: string;
    source: string;
    effectiveVersion: string;
    className: string;
  };
  methods: ReadonlyMap<string, UserlandMethodAuthority>;
  digest: string;
}

type UserlandMethodAuthority =
  | {
      kind: "open";
      tier: "open";
      access: EffectiveMethodAccess;
      producesHandle?: UserlandHandleProduction;
    }
  | {
      kind: "protected";
      localCapability: string;
      canonicalCapability: string;
      definitionDigest: string;
      tier: "gated" | "critical";
      sensitivity: "read" | "write" | "admin" | "destructive";
      resource:
        | { kind: "receiver-object"; resourceType: string }
        | { kind: "opaque-handle"; resourceType: string; argument: number };
      access: EffectiveMethodAccess;
      producesHandle?: UserlandHandleProduction;
    };

interface UserlandHandleProduction {
  localCapability: string;
  canonicalCapability: string;
  definitionDigest: string;
  resourceType: string;
}

interface EffectiveMethodAccess {
  principals: readonly ("host" | "user" | "code" | "session" | "mission")[];
  codeOnly: boolean;
  codeReachable: boolean;
}

interface ExactResolvedService {
  stateHash: string;
  binding: ExactWorkspaceServiceBinding;
  catalog: UserlandServiceAuthorityCatalog;
}
```

`codeReachable` is the normalized result of the method's receiver declaration;
it is not inferred from `codeOnly` alone. A method is statically reachable by
installed code only when both the service binding and effective method access
admit the code principal.

The catalog digest covers provider effective version, class, method names,
effective access, effect kinds, sealed capability identities, resource
selectors, input-contract digests, and schema/analyzer version. It excludes
service aliases and descriptive text that cannot change provider method
authority. The exact resolution digest separately covers service name,
protocols, service principals, target, reviewed title/action/description and
presentation vocabulary, and catalog digest.

`WorkspaceRpcMethodDoc.effect` currently has an intermediate
`host-capability` variant. The extractor must preserve it until sealing so it
cannot disappear silently, but it does not become a third valid userland
method kind: current sealing intentionally rejects a workspace provider that
claims a host-owned capability. The resolver reports that as a provider
contract error. Supporting host-owned effects on workspace RPC would be a
separate authority-model decision, not an inference feature.

### 5.3 Consumer facts

Consumer analysis should first produce facts independent of the current
provider catalog:

```ts
interface WorkspaceServiceCallFact {
  id: CallFactId;
  serviceQueries: AbstractString;
  methods: AbstractString;
  objectKeys: AbstractString | { kind: "not-applicable" };
  arguments: readonly SymbolicArgumentValue[];
  origin: {
    unitName: string;
    package?: {
      kind: "workspace" | "external";
      name: string;
      versionOrEffectiveVersion: string;
      contentDigest: string;
    };
    file: string;
    line: number;
    column: number;
  };
}

type SymbolicArgumentValue =
  | { kind: "literals"; values: ReadonlySet<string> }
  | { kind: "service-call-result"; producerCallId: CallFactId }
  | { kind: "unknown" };
```

Facts are cached by executable module-closure digest plus analyzer version.
They can then be composed cheaply with different exact-state service bindings
and provider catalogs. They deliberately contain no provider capability,
definition digest, resource type, or `producesHandle` conclusion: those are
catalog-derived facts and would make this cache stale across provider changes.

During exact-state composition, resolve a symbolic `service-call-result` by
looking up its producer call, resolving that producer's exact service and
method, and inspecting the method's sealed `producesHandle`. Only then may the
result become a resolved abstract userland handle.

### 5.4 Required effect

Catalog resolution produces a manifest-facing requirement:

```ts
interface RequiredAuthorityEffect {
  capability: string;
  tier: "gated" | "critical";
  operation: "service-resolution" | "service-invocation" | "method-effect";
  resource:
    | { kind: "exact"; key: string }
    | { kind: "prefix"; prefix: string };
  providerCatalogDigest?: string;
  serviceName?: string;
  method?: string;
  origin: WorkspaceServiceCallFact["origin"];
}
```

Service resolution always contributes `workspace-service:<name>` at gated
tier. A protected method additionally contributes its canonical userland
capability. Open methods contribute no method capability.

### 5.5 Total resolution results

Service and method resolution are total, discriminated operations. Absence or
ambiguity must never collapse to an empty effect set:

```ts
type ServiceResolution =
  | { kind: "resolved"; service: ExactResolvedService }
  | { kind: "missing"; query: string }
  | { kind: "inaccessible"; query: string; service: ExactResolvedService }
  | { kind: "unbounded" };

type MethodResolution =
  | { kind: "resolved"; method: UserlandMethodAuthority }
  | { kind: "missing"; method: string }
  | { kind: "inaccessible"; method: string; authority: UserlandMethodAuthority }
  | { kind: "dynamic"; reachable: readonly UserlandMethodAuthority[] };
```

Exact environment construction rejects duplicate service names or protocols
before lookup, as the runtime workspace declaration builder already does. An
`ambiguous` environment-construction error may still exist defensively, but it
is not an ordinary consumer lookup outcome. A finite query union retains one
resolution result per member so a missing branch cannot be hidden by successful
branches.

## 6. Exact provider catalog resolution

### 6.1 Resolution procedure

For a service query in state `S`:

1. Resolve the literal name or protocol against the exact service declarations.
   Construct the declaration map through the canonical workspace declaration
   validator so duplicate names/protocols fail before consumer analysis.
2. Find the provider `GraphNode` in the exact package graph.
3. Obtain its effective version from the exact view.
4. Materialize the provider and its package dependencies from `S` through the
   existing build source provider.
5. Parse the materialized provider manifest, including durable classes and
   `vibestudio.authority.provides`.
6. Resolve any declared workspace RPC schema through
   `workspaceRpcSchemas.ts`.
7. Run `collectWorkspaceRpcCatalog` over the materialized provider source.
8. Project and digest the authority-relevant catalog fields.

The resolver does not require an active runtime image and does not launch the
provider. It must not consult `entityCache`, the currently active build, or the
mutable checkout.

The result is `ExactResolvedService`: the state and service binding wrap a
state-independent provider catalog. Reusing identical provider bytes across
two states therefore cannot return a catalog carrying the first state's hash.

### 6.2 Failure behavior

The resolver fails closed for:

- a service whose source is not an exact-state build unit;
- a declared durable class missing from the provider manifest;
- a protected method referencing an undeclared provided capability;
- a provided capability bound to no production method;
- a method whose decorator and typed schema disagree;
- duplicate protocol ownership;
- a literal service query with no exact binding;
- a literal method missing from the exact provider class catalog;
- an invalid or non-deterministic catalog digest.

When the provider itself is part of the affected set, its report owns the
primary diagnostic. A consumer report may additionally state that its
authority could not be resolved because the provider catalog is invalid, but
must not manufacture a missing consumer request from incomplete data.

Missing services and methods are call-contract diagnostics at their respective
source expressions, not manifest-coverage diagnostics. For a finite union,
each missing member is reported even when other members resolve. A deleted
method can therefore never degrade to open or to “no inferred effect.”

### 6.3 Cache identity and coalescing

Use two bounded caches:

```text
provider catalog key =
  provider effective version
  + provider authority manifest digest
  + provider class
  + RPC schema catalog version
  + analyzer version

exact service resolution key =
  exact state hash
  + exact service binding digest
  + provider catalog digest
```

Concurrent reports requesting the same provider key share one Promise.
Rejected flights are evicted immediately. Completed entries use a bounded LRU
or the repository's existing bounded content-addressed cache primitive; an
unbounded `Map<stateHash, ...>` is not acceptable in the long-lived server.

## 7. Consumer analysis

### 7.1 Analysis boundary

Run first-party and workspace-package TypeScript over the exact `ts.Program`
already created by `TypeCheckService`. Preserve source-file identity and
TypeScript symbols; do not concatenate the program to one string for userland
call analysis.

That Program is not the complete executable universe: external `node_modules`
are currently provisioned primarily for type resolution, so bundled npm
implementation files may be absent. Authority analysis must additionally
consume the exact executable module closure selected by the real build:

```ts
interface ExecutableModuleInput {
  moduleId: string;
  contentDigest: string;
  package:
    | { kind: "first-party" }
    | { kind: "workspace"; name: string; effectiveVersion: string }
    | { kind: "external"; name: string; version: string; packageDigest: string };
  format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
  source: string;
}
```

Derive this closure from the same resolver/module map and esbuild input graph
that determines the executable artifact. Extend build results with a
content-addressed module-closure projection; do not infer the universe by
walking all of `node_modules`, trusting registry metadata, or scanning packages
that the target does not execute. Persisted metadata contains repository/package
coordinates and content digests, never machine-specific absolute paths.

Run the same call-fact analyzer over external JavaScript/TypeScript
implementation bytes, with ESM and CommonJS root-import recognition, and cache
each package/module summary by content digest plus analysis epoch. Compose those
summaries with the first-party Program before provider resolution. This is one
fact IR and one coverage implementation, not a second dependency inference
table.

Continue excluding implementation modules that merely implement the host-owned
runtime transport and are not endowed as consumer code. Effects originating in
any ordinary workspace or external dependency remain charged to the executable
principal and retain exact package provenance for manifest comparison.

If external executable bytes are not yet included, the implementation must
label its result workspace-source-only and may not claim complete `packages`
endowment validation or satisfy this plan's definition of done.

### 7.2 Recognized roots

Resolve symbols, not local variable spellings, for the public userland service
APIs:

- `workers.resolveService(...)`;
- `runtime.workers.resolveService(...)`;
- `workers.durableObjectService(...)`;
- `runtime.workers.durableObjectService(...)`;
- `rpc.call(...)`, `rpc.stream(...)`, and `rpc.streamReadable(...)`;
- their `runtime.rpc` equivalents;
- typed userland service clients whose construction includes a literal service
  query and whose called method is visible to the program.

Re-exported or aliased imports should resolve to the same root symbol. An
unrelated object named `workers` or `rpc` must not produce authority facts.

### 7.3 Bounded abstract values

Use a small purpose-built abstract interpretation rather than attempting a
general JavaScript proof:

```ts
type AbstractString =
  | { kind: "literals"; values: ReadonlySet<string> }
  | { kind: "symbolic"; valueId: string }
  | { kind: "unknown" };

type AbstractServiceHandle = {
  queries: AbstractString;
  objectKeys: AbstractString | { kind: "not-applicable" };
};
```

Propagate these values through:

- `const` assignments and aliases;
- `await` and parentheses;
- property extraction and destructuring of `targetId`;
- conditional expressions and finite literal unions;
- simple object/array transport where the TypeScript symbol remains visible;
- function returns and parameters through bounded function summaries;
- imported workspace-package wrappers included in the same Program;
- external executable package summaries from the exact module closure;
- symbolic service-call results into assignments, returns, parameters, and
  later method arguments without deciding whether the result is a handle.

Function summaries should be computed to a fixed point over the Program and
contain only abstract service handles and workspace-service call facts. They
must have a deterministic iteration bound and collapse to `unknown` rather
than grow without limit.

The analyzer does not need to model arbitrary heap mutation, reflection,
`eval`, or unbounded string construction. Those cases are governed by §9.

### 7.4 Binding a call to a service

A direct call is a userland service call only when its target is proven to
derive from a resolved service handle:

```ts
const service = await workers.resolveService(protocol, objectKey);
await rpc.call(service.targetId, method, args);
```

An arbitrary `rpc.call(target, method, args)` must not be guessed to belong to
a workspace service. Existing direct-RPC validation continues to own that
case.

Calls through `durableObjectService(query, key)` retain the query and key on
the returned client so a subsequent method call can be bound without exposing
`targetId` in source.

Default object keys are resolved by a shared service-target helper also used by
runtime resolution. The analyzer must not independently guess singleton versus
factory behavior or manufacture a default key.

### 7.5 Literal types

Before declaring a value unknown, consult the TypeScript type checker. A value
typed as:

```ts
type ChannelMutation = "removeMember" | "archive";
```

is a finite method set even when its runtime value is a variable. The same
applies to finite protocol unions and `as const` arrays.

Do not treat the unconstrained `string` type as a finite set, and do not infer
from comments, variable names, or documentation text.

## 8. Mapping calls to manifest requirements

### 8.1 Service admission

`workspace-service:<service-name>` protects two distinct operations when the
consumer performs both:

```ts
type WorkspaceServiceAdmissionEffect =
  | {
      operation: "service-resolution";
      capability: `workspace-service:${string}`;
      resource: ResourceScope;
    }
  | {
      operation: "service-invocation";
      capability: `workspace-service:${string}`;
      resource: ResourceScope;
    };
```

The resolution call contributes `service-resolution` plus the transitive host
prerequisite for the public resolution method. Its resource is the exact
resolved target ID for a Durable Object or route base path for a stateless
worker, matching `workers.resolveService` runtime preparation.

A direct userland RPC call contributes `service-invocation`. For an open method
its resource is the direct target audience. For a protected receiver-object
method it is the method's receiver resource; for an opaque-handle method it is
the resolved handle resource. Runtime deliberately evaluates the target-service
requirement on this invocation-selected resource, so the static manifest must
cover it independently of the earlier resolution target.

Put this mapping behind shared operation-to-resource projections used by
runtime preparation/attestation and analysis:

```ts
workspaceServiceResolutionResource(binding, objectKey)
workspaceServiceInvocationResource(binding, methodAuthority, objectKey, resolvedHandle)
```

The analyzer emits only operations actually present in the executable closure.
A target received from an already resolved handle may contribute invocation
without resolution; code that resolves but never invokes contributes resolution
without invocation.

This requirement remains necessary even when the selected provider method is
open: service visibility and method effect are separate receiver checks.

### 8.2 Protected methods

For each selected protected method, require the catalog's canonical capability:

```text
userland:<provider-source>/<local-name>#<definition-digest>
```

The recommended author contract is the already supported provider-bound
definition family:

```json
{
  "capability": "userland:workers/pubsub-channel/channel.members.remove#*",
  "resource": { "kind": "prefix", "prefix": "channel:" },
  "tier": "critical",
  "evidence": "bounded-dynamic"
}
```

The family survives provider rebuilds while remaining bound to one provider
and one named capability. The runtime continues to authorize the exact sealed
definition digest. Static family matching must use the shared
`capabilityPatternCovers` implementation.

### 8.3 Tier matching

A manifest request covers an inferred effect only when its tier equals the
provider definition's tier. A gated request cannot cover a critical method,
and a critical request cannot reinterpret a gated method.

If a provider changes a capability from gated to critical, every consumer is
revalidated and receives a tier-mismatch diagnostic even if its capability
family string is unchanged.

### 8.4 Resource coverage

Resource identities are a shared runtime/static contract, not strings owned by
the analyzer. Move their construction behind shared canonical helpers used by
both `rpcServer` / `UserlandResourceHandleStore` and build analysis:

```ts
userlandReceiverResourceKey(resourceType, source, className, objectKey)
userlandReceiverResourcePrefix(resourceType, source, className)
userlandHandleResourceKey(resourceType, handle)
userlandHandleResourcePrefix(resourceType)
```

Provider composition resolves symbolic call results into the complete
non-secret binding enforced by the runtime handle store:

```ts
interface ResolvedAbstractUserlandHandle {
  workspaceId: string;
  canonicalCapability: string;
  definitionDigest: string;
  provider: string;
  receiverSource: string;
  receiverClass: string;
  receiverObjectKeys: AbstractString;
  resourceType: string;
}
```

The exact build environment supplies workspace identity. A producer call
supplies receiver source/class and its abstract object-key identity. The sealed
`producesHandle` entry supplies canonical capability, definition digest,
provider, and resource type. Keeping the definition digest explicit mirrors
runtime validation even though it is also committed by the canonical
capability string.

Extract the exact runtime handle-binding field vocabulary and equality check
into a shared contract. Static compatibility compares abstract bindings with
the same fields; it must not maintain a shorter, independently invented list.

For the current runtime formats, the helpers produce receiver keys shaped as
`${resourceType}:do:${source}:${className}:${objectKey}` and handle keys shaped
as `${resourceType}:handle:${handle}`. Those formats must no longer be
reimplemented inline on either side.

Use the sealed provider resource declaration and shared helpers to derive the
narrowest sound manifest requirement:

- `receiver-object` with a literal singleton/factory object key produces an
  exact receiver resource key through `userlandReceiverResourceKey`;
- `receiver-object` with a bounded key set produces that finite set of exact
  requirements;
- `receiver-object` with an unknown key produces a prefix requirement bounded
  to the provider, class, and declared resource type through
  `userlandReceiverResourcePrefix`;
- a handle statically traced from a producing method must match the consuming
  method's workspace, canonical capability, definition digest, provider,
  receiver source, receiver class, receiver object-key identity, and resource
  type, then requires the shared
  `userlandHandleResourcePrefix(resourceType)` because the random concrete
  handle does not exist at build time;
- a known mismatch is a call-contract diagnostic: adding authority cannot make
  a handle minted for object A valid on object B;
- identical symbolic object-key identities prove compatibility even when the
  concrete key is not a literal;
- an opaque-handle argument with a known compatible resource type but
  incomplete receiver identity uses the shared handle prefix conservatively
  and remains visibly unresolved because runtime compatibility is not proven;
- an opaque-handle argument whose resource type cannot be established produces
  an unresolved-resource diagnostic rather than a broad empty-prefix
  requirement.

Coverage rules are structural:

- an exact manifest scope covers only the same exact key;
- a prefix manifest scope covers an exact key beginning with the prefix;
- a prefix manifest scope covers a required prefix only when it is an ancestor
  of that entire required prefix;
- origin/domain/network scopes never accidentally cover a userland receiver
  resource unless the shared authority model explicitly defines that relation.

The runtime remains responsible for the concrete resource selected by an
invocation and for validating opaque handles. Static validation verifies that
the installed-code ceiling is broad enough for the statically reachable set,
not that a grant exists.

### 8.5 Dependency provenance

When a workspace package in the executable closure introduces the call, retain
its package name in the required effect. The shared comparator applies these
explicit rules:

- first-party-origin effects are covered by a matching request whether or not
  that request has `packages`;
- dependency-origin effects require the dependency's exact package name in the
  matching request's `packages` list;
- an absent `packages` field therefore admits first-party code only and routes
  the endowment to no dependency;
- when a dependency wrapper performs the service call, the dependency remains
  the origin even if first-party code called the wrapper;
- when a dependency merely returns data or a service/handle value and
  first-party code performs the eventual protected call, the call is
  first-party-origin;
- if several origins contribute the same effect, every origin must be covered;
  diagnostics consolidate the effect but list each uncovered package.

`packages` is static endowment-routing provenance. Runtime receiver
authorization continues to evaluate the executable code principal and concrete
resource; it does not reinterpret a package name as a runtime principal.

### 8.6 Shared coverage implementation

Replace the authority fold's current capability-only membership helper with a
shared manifest-coverage function that evaluates:

```text
capability pattern + tier + resource envelope + package provenance
```

Host and userland effects should use the same comparator. This avoids making
userland checking more correct than the host checker while preserving two
drifting definitions of “declared.”

## 9. Dynamic behavior

### 9.1 Known service, dynamic method

If the service is known but the method is not statically bounded, the code can
reach any method on that receiver. Require the union of every protected method
in the exact provider catalog whose effective access admits code. Effective
access composes the service binding's principals with method principals and
`codeOnly` policy. Methods unavailable to code do not inflate the manifest;
attempting to name one literally produces an inaccessible-method contract
diagnostic.

This may produce several provider-bound capability families, but it is not a
prompt-storm bug: genuinely dynamic installed code has selected that whole
receiver surface. The diagnostic should recommend narrowing the method value
to a literal union when that breadth was accidental.

### 9.2 Finite dynamic service set

Resolve every member, union the resulting service admissions and method
effects, and retain per-branch provenance. Duplicate effects are collapsed by
canonical capability, tier, resource, and package origin.

### 9.3 Unknown service

When a standard `resolveService` call receives an unconstrained service query,
emit one unresolved-authority diagnostic at the query expression:

```text
Authority analysis cannot bound this workspace service query. Use a literal or
finite literal union so the build can determine which provider authority the
installed code may exercise.
```

Do not infer all workspace services. Doing so couples unrelated providers,
inflates manifests and approval reviews, and makes adding a service silently
widen every dynamic consumer.

An existing broad `workspace-service:*` request does not suppress this
diagnostic because it cannot identify which provider-owned method capability
families are reachable.

### 9.4 Missing literal service or method

A literal query that resolves to no exact service produces a missing-service
contract diagnostic at the query. A literal method absent from the resolved
provider class produces a missing-method contract diagnostic at the method
argument or property. Neither case produces an empty effect set, defaults to
open, or becomes a suggestion to add authority.

For finite unions, successful members continue to produce their effects while
each missing member remains an error.

### 9.5 Unknown method on an unresolved target

Do not report a userland-specific error unless the target is proven to derive
from the standard service resolver. This prevents false positives on ordinary
RPC transports while leaving runtime receiver enforcement intact.

### 9.6 Evaluated agent code

This plan applies to fixed installed code included in a unit's build. Dynamic
agent eval follows the living-profile negotiation model in
`docs/agentic-authority-negotiation-plan.md`; it must not be forced into a
future-code manifest prediction model merely because it uses the same service
transport.

## 10. Authority dependency index

### 10.1 Why a separate analysis graph is necessary

Module dependencies answer “what must be built before this unit?” Userland
authority dependencies answer “whose receiver declaration changes this unit's
static authority result?” They are different relations.

Adding service edges to `PackageGraph` would be incorrect:

- service calls do not make provider code part of the consumer bundle;
- provider and consumer may call one another;
- build ordering requires a DAG, while service relationships may cycle;
- a provider authority change should invalidate diagnostics, not the
  consumer's runtime artifact bytes.

Define a derived `AuthorityDependencyIndex` instead:

```ts
interface AuthorityAnalysisEpoch {
  analyzerVersion: string;
  rpcSchemaVersion: string;
}

interface AuthorityDependencyIndex {
  stateHash: string;
  epoch: AuthorityAnalysisEpoch;
  complete: boolean;
  consumerInputs: ReadonlyMap<string, {
    effectiveVersion: string;
    moduleClosureDigest: string;
    serviceQueries: ReadonlySet<string>;
  }>;
  providersByQuery: ReadonlyMap<string, {
    providerUnit: string;
    catalogDigest: string;
  }>;
  consumersByQuery: ReadonlyMap<string, ReadonlySet<string>>;
  consumersByProviderUnit: ReadonlyMap<string, ReadonlySet<string>>;
  blockingConsumers: ReadonlySet<string>;
  digest: string;
}
```

`providersByQuery` and `consumersByQuery` contain every usable alias: canonical
service name and every protocol. A protocol removal or remapping can therefore
look up both the old and new consumer sets directly.

This graph is part of build-report analysis. It does not authorize calls and
does not create a second publication gate.

### 10.2 Constructing the index efficiently

Consumer facts are cached by effective version. Composing an index for a state
therefore usually means resolving cached service queries against a small
configuration table rather than rescanning source.

On the first relevant protected push after a cold restart:

1. Load a complete published-state baseline matching the current analysis
   epoch, or construct one lazily.
2. When constructing a new epoch baseline, analyze every relevant executable
   consumer. Manifest prefiltering is not sound for this step because the
   checker must discover missing declarations.
3. Mark the baseline complete only after every relevant unit has either
   produced consumer facts or a recorded blocking diagnostic.
4. Analyze candidate-changed units and compose the candidate index from cached
   facts plus those new results.
5. Cache facts by effective version and epoch.

After a complete baseline exists for the current epoch, incremental candidate
analysis may prefilter unchanged units using the dependency index. A migration
run or an assertion that published `main` was previously clean is not a
substitute for a recorded current-epoch baseline.

Completeness means coverage, not success. Consumers with blocking baseline
diagnostics remain in `blockingConsumers` and are included in every protected
candidate's affected set until candidate source/configuration makes their
current-epoch report pass. A failed baseline can therefore never become a
reason to skip the failing unit.

The baseline may be recomputed after every process restart without violating
correctness. To avoid repeated cold-start work, it may instead be persisted as
a content-addressed artifact containing state hash, epoch, index digest, and
the effective version plus executable module-closure digest of every covered
consumer. A persisted marker is usable only after all of those identities
verify; a bare boolean in mutable state is not sufficient.

### 10.3 Epoch changes

Analyzer behavior and host-owned workspace RPC schemas change outside the
workspace state graph. The pair forms the authority-analysis epoch.

`analyzerVersion` is an explicit inference ABI version. `rpcSchemaVersion` is
the deterministic digest of the actual host-owned workspace RPC schema catalog,
not a manually maintained label. Any authority-relevant schema change therefore
changes the epoch mechanically.

If no complete published baseline exists for the current epoch, protected
publication must complete that baseline—or conservatively schedule all
relevant executable consumers—before it may use incremental affected-unit
selection. This applies even when the candidate changes an unrelated file.

An epoch change invalidates consumer fact caches, provider catalog projections,
and authority dependency indices. It does not change runtime artifact keys.

### 10.4 Candidate and published union

Extend `listAffectedBuildUnits` with the authority equivalent of its existing
package-graph union:

```text
affected =
  package reverse closure(candidate seeds, candidate graph)
  union package reverse closure(published seeds, published graph)
  union authority consumers(candidate provider changes, candidate index)
  union authority consumers(published provider changes, published index)
  union current-epoch blocking baseline consumers
```

Using both authority views catches:

- newly introduced service relationships;
- removed calls and protocols;
- provider deletion or replacement;
- service rename;
- protocol remapping from one provider to another;
- capability removal or rebinding.

The result remains a bounded set of relevant units rather than a whole-workspace
build.

### 10.5 Configuration changes

Changes to `meta/vibestudio.yml` may not map to an ordinary package seed. Diff
the published and candidate exact service bindings. For every added, removed,
or changed binding, seed:

- the old provider, when still present;
- the new provider;
- consumers of the old name/protocol;
- consumers of the new name/protocol.

Presentation-only service changes do not invalidate authority unless they are
part of the reviewed authority presentation contract. Service principals,
provider source, target class, protocols, and action/presentation fields used
by approval copy are authority-relevant and must be classified explicitly in
the binding digest.

### 10.6 Successful candidate promotion

Candidate validation produces a complete candidate index for the exact
candidate state and current epoch by applying candidate changes to a verified
complete published baseline. Validation stores that index as a pending,
content-addressed promotion keyed by candidate state hash, epoch, and index
digest. It does not replace the published baseline yet: validation may be
followed by denial, failure, or a competing publication.

After protected publication succeeds, the canonical
`protected-publication` event names the exact resulting workspace state. The
authority index manager compares that state and current epoch with the pending
promotion and atomically swaps the published-baseline pointer to the candidate
index. Persisted index bytes are written before the pointer; pointer replacement
is transactional/atomic through the chosen store. Only an exact state/epoch
match may promote.

Failed, denied, superseded, or expired candidates discard their pending
promotions. If the process crashes after `main` advances but before promotion,
the old baseline's state hash does not match published `main`; the next
protected validation rebuilds or verifies the new baseline before incremental
selection. A crash therefore costs recomputation, never stale acceptance.

## 11. Analysis identity and caching

Runtime bundle identity and authority-analysis identity must remain separate.
Changing a remote provider's method authority does not change the consumer's
JavaScript bytes, so it must not falsify or churn the consumer build key.

Define an authority-analysis key:

```text
sha256(
  authority-analysis epoch,
  consumer effective version,
  executable module-closure digest,
  consumer authority manifest digest,
  exact service binding digest,
  referenced provider catalog digests
)
```

The build report may cache authority diagnostics under this key. Esbuild and
TypeScript continue using their existing identities. The report merges all
three producers into the existing diagnostic schema.

Requirements:

- cache hits never skip exact-state service binding resolution;
- provider catalog digests are sorted before hashing;
- failed analyses are not retained as successful cache entries;
- caches are bounded;
- in-flight work is coalesced;
- invalidation is content-addressed, not timer-based;
- incremental affected-unit selection requires a complete baseline for the
  current epoch;
- persisted baselines verify state, epoch, index digest, covered effective
  versions, and executable module-closure digests before use;
- no authority cache is used as runtime authorization evidence.

## 12. Build and protected-publication integration

### 12.1 Typecheck fold

Extend `typecheckUnit` authority options with an exact-state resolver rather
than passing only `Map<protocol, serviceName>`:

```ts
authority?: {
  manifest: PackageManifest;
  environment: ExactWorkspaceAuthorityEnvironment;
  executableModules: readonly ExecutableModuleInput[];
  resolveService(query): Promise<ServiceResolution>;
}
```

The fold obtains the exact Program plus the build-selected executable module
closure, computes one set of consumer facts, resolves required effects, and
appends `source: "authority"` diagnostics.

Failure to obtain the Program or exact authority environment remains
fail-closed. Provider resolution failures should remain `authority` errors,
not be mislabeled as `tsc` failures.

### 12.2 Build report

`getBuildReport(unit, state)` remains the public operation. It must return the
same userland diagnostics whether called manually inside the sandbox or by the
protected-main validator.

`buildOneTarget` retains the successful build's exact executable module-closure
projection and passes it to the authority fold. A build failure already blocks
publication; authority analysis must not substitute a guessed dependency
universe when no exact build input graph exists.

The report should expose the authority-analysis key or referenced catalog
digests only if useful for diagnostics/debugging. They are not required in the
ordinary user-facing payload.

### 12.3 Protected `main`

The existing validation sequence remains:

1. Load exact candidate workspace configuration.
2. Compute affected units.
3. Request their exact-state build reports concurrently.
4. Reject on any error diagnostic through `BuildGateFailedError`.
5. Stage the complete candidate authority index on success and promote it only
   after the matching protected-publication event confirms that exact state.

There is no new approval. A missing declaration is a source/build error; the
author either removes the call or intentionally edits the manifest, after
which normal install/version review and runtime grants apply.

## 13. Diagnostics and developer experience

Diagnostics should lead with the code-to-contract mismatch, not internal
catalog vocabulary.

### 13.1 Missing method capability

```text
panels/chat/index.tsx:142:18
Calling channel.removeMember requires the provider capability
'channel.members.remove', but panels/chat/package.json does not request
userland:workers/pubsub-channel/channel.members.remove#* at critical tier.
```

Suggestion:

```text
Add the narrowest reviewed request for this provider capability and receiver
resource, or remove/narrow the call. A request is not a grant.
```

### 13.2 Provider changed beneath an unchanged consumer

```text
workers/pubsub-channel changed removeMember from open to critical authority.
This unchanged consumer is rechecked because it calls that provider method.
```

Include both provider and consumer coordinates in structured diagnostic detail
when the wire schema grows support for related locations. Until then, place the
primary diagnostic at the consumer call and name the provider source in the
message.

### 13.3 Dynamic breadth

When a dynamic method selects many protected effects, emit one summary
diagnostic followed by individual missing requirements in stable sorted order.
Do not produce one opaque aggregate capability and do not emit repeated copies
for multiple equivalent call sites.

### 13.4 Resolution and access failures

Keep call-contract failures distinct from manifest-coverage failures:

- missing service: name the unresolved literal query and exact state;
- invalid/ambiguous environment: point to the conflicting workspace service
  declarations;
- inaccessible service: explain that its service principals do not admit
  installed code;
- missing method: name the exact provider class and method;
- inaccessible method: explain that its effective method access does not admit
  installed code;
- unresolved opaque handle: name the required handle resource type and the
  argument whose provenance could not be established.

None of these diagnostics should suggest adding a capability request when no
such request could make the call valid.

### 13.5 Discoverability

Update live capability documentation and workspace development guidance to
show:

- how service-level and method-level authority compose;
- why provider-bound `#*` families remain reviewable across provider versions;
- how literal unions improve static precision;
- how to inspect the exact provider method contract;
- why editing a manifest does not grant the capability.

## 14. Shared tooling and removal of special cases

The exact-state checker and checkout audit must share:

- consumer fact extraction across the first-party Program and exact external
  executable module closure;
- provider catalog projection;
- capability/tier/resource/provenance coverage;
- dynamic-call rules;
- deterministic sorting and diagnostic identifiers.

`generate-unit-authority-manifests.mjs` may use this machinery to propose a
reviewable patch in its explicit write mode. Normal build and typecheck paths
remain read-only.

Once generic method resolution covers typed workspace clients, delete
handwritten call-name effects such as the current `removeMember` mapping in
`inferTypedWorkspaceEffects`. Keeping both would create two authorities for
the same fact and eventually drift.

Known userland client name tables should likewise disappear when their public
construction carries a resolvable protocol/service identity. Any client that
cannot expose that identity through its typed API is an API design problem to
fix at the client boundary, not a reason for another scanner exception.

## 15. Implementation sequence

### Phase A — shared contracts and exact environment

1. Define exact service binding, provider catalog projection, consumer fact,
   required effect, and authority-analysis result types.
2. Extend the build root callback to return exact provider identity, not only
   name/protocol pairs, including service principals and reviewed presentation.
3. Define the authority-analysis epoch and complete-baseline record.
4. Add deterministic digest helpers and bounded single-flight caches.
5. Reuse canonical workspace declaration validation for duplicate names and
   protocols.

Exit criterion: an exact state can resolve a service query to one immutable
provider coordinate without consulting live runtime state.

### Phase B — reusable provider catalog resolver

1. Refactor authority-relevant projection out of the worker build path while
   retaining `collectWorkspaceRpcCatalog` as the single extractor.
2. Materialize provider closures through the exact build source provider.
3. Resolve manifest-declared RPC schemas.
4. Preserve extracted access metadata and normalize effective code
   reachability.
5. Reject extracted host-owned effects explicitly during userland sealing.
6. Seal and digest state-independent authority catalogs.
7. Wrap catalogs in exact-state service resolutions.
8. Integrate provider catalog failures with build diagnostics.

Exit criterion: a test can obtain identical catalogs from a provider build and
from diagnostic-only exact-state resolution, and a one-byte authority change
changes the catalog digest.

### Phase C — exact executable consumer analyzer

1. Capture the exact executable module closure and content digests from the
   real build resolver/esbuild input graph.
2. Resolve public runtime API symbols in first-party, workspace-package, and
   external ESM/CommonJS implementation modules.
3. Implement bounded literal, service-handle, argument, and symbolic
   service-call-result propagation without consulting provider catalogs.
4. Cache external module/package summaries by content digest and epoch.
5. Add function summaries and fixed-point convergence.
6. Recognize direct RPC and durable service client calls.
7. Retain source and exact package provenance.
8. Return missing, inaccessible, ambiguous-environment, and unresolved facts
   explicitly rather than dropping them.

Exit criterion: representative workspace call styles produce stable structured
facts without local-variable-name false positives, and an executable npm
dependency calling an endowed service contributes the same fact IR with its
package origin.

### Phase D — effect resolution and manifest comparison

1. Compose consumer facts with exact service bindings.
2. Resolve selected provider methods.
3. Resolve symbolic producer-call results through exact `producesHandle`
   catalogs and compare their full receiver bindings with opaque-handle
   consumers.
4. Produce separate service-resolution, service-invocation, and method effects.
5. Extract shared service-operation, receiver, and handle resource codecs plus
   exact handle-binding comparison from runtime, and use them in analysis.
6. Implement shared capability/tier/resource/package coverage with the
   explicit provenance rules in §8.5.
7. Emit source-positioned authority and call-contract diagnostics.
8. Remove covered handwritten userland inference mappings.

Exit criterion: build reports detect missing userland method declarations and
remain clean for valid provider-bound families.

### Phase E — provider-responsive invalidation

1. Add the epoch-qualified authority dependency index with service-name and
   protocol alias maps.
2. Cache consumer facts by effective version and epoch.
3. Build or verify a complete published baseline before incremental selection.
4. Build candidate indices lazily from that baseline plus changed units.
5. Extend affected-unit calculation with the published/candidate union.
6. Handle service-configuration changes explicitly.
7. Add authority-analysis cache keys based on provider catalog digests.
8. Optionally persist content-addressed complete baselines; never persist an
   unverified mutable completeness flag.
9. Stage candidate indices by exact state and epoch, then atomically promote
   them only from the matching successful protected-publication event.

Exit criterion: modifying only provider authority causes an unchanged consumer
report to rerun and protected `main` to reject when its manifest is no longer
sufficient.

### Phase F — migration and documentation

1. Run a full userland call classification pass.
2. Review proposed provider-bound family requests.
3. Update manifests explicitly.
4. Update workspace build/typecheck and capability documentation.
5. Remove obsolete inference tables and tests.

Exit criterion: the checkout authority audit and exact-state build reports use
one implementation and all current executable units are clean.

## 16. Test plan

### 16.1 Provider catalog tests

- open method projection;
- receiver-object protected method;
- opaque-handle producer and consumer;
- handle production absent/present across two provider catalog versions while
  consumer facts remain byte-identical;
- service and method principals plus `codeOnly` projection;
- service/method effective code reachability;
- extracted host-capability effect rejected during userland sealing;
- decorator/schema agreement;
- undeclared provided capability rejection;
- unbound provided capability rejection;
- deterministic ordering and digest;
- digest changes for tier, effect, resource, schema, and definition changes;
- digest stability for irrelevant formatting and file traversal order.

### 16.2 Consumer analyzer tests

- direct literal protocol and method;
- service-name resolution;
- `runtime.workers` and `runtime.rpc` forms;
- aliases, `await`, parentheses, and destructured `targetId`;
- conditional and finite literal-union services/methods;
- typed `as const` values;
- wrapper function return and parameter flow;
- imported workspace-package wrapper;
- bundled npm ESM and CommonJS implementations;
- unused npm package excluded from the executable module closure;
- external package summary cache invalidated by content digest and epoch;
- `durableObjectService` client;
- unrelated local objects named `workers` or `rpc`;
- arbitrary direct RPC target not misclassified;
- dynamic method and unknown service behavior;
- missing literal service and method behavior;
- one missing member inside an otherwise valid finite union;
- handle producer-to-consumer argument flow;
- symbolic producer result resolved only during provider composition;
- unknown handle provenance and resource type;
- stable file/line/package provenance.

### 16.3 Manifest coverage tests

- exact canonical capability;
- provider-bound `#*` family;
- wrong provider or local capability;
- wrong tier;
- exact resource match and mismatch;
- covering and non-covering resource prefixes;
- canonical receiver and handle resource codecs shared with runtime;
- distinct workspace-service resolution and invocation resources;
- open-method target audience and protected receiver/handle invocation
  resources matching runtime projections;
- handle compatibility across workspace, definition digest, provider,
  receiver source/class/object key, and resource type;
- known cross-object handle mismatch versus relationally identical symbolic
  object keys;
- first-party effects with absent/present `packages`;
- dependency effects with absent, matching, and non-matching `packages`;
- local wrappers around dependency calls;
- several origins contributing one effect;
- open method requiring no method capability;
- service admission still required for open methods.

### 16.4 Invalidation tests

Use two exact states with unchanged consumer source and verify revalidation for:

- open to gated;
- gated to critical;
- capability rename;
- capability definition digest change;
- resource selector change;
- method removal;
- protocol removal/remapping;
- provider source/class replacement;
- provider deletion;
- service presentation/authority-principal change when classified relevant;
- title/action/description/presentation changes alter the exact binding digest.

Also verify:

- added and removed dependency edges use candidate/published union;
- mutually calling services do not create package-graph cycles;
- unrelated provider changes do not rebuild or recheck the consumer;
- concurrent consumer reports extract one provider catalog;
- failed catalog flights retry after source correction.
- cold restart requires a current-epoch complete baseline;
- analyzer-version and RPC-schema-version changes rebaseline unchanged
  consumers;
- an incomplete or mismatched persisted baseline is rejected;
- a blocking diagnostic discovered during baselining remains affected on every
  protected candidate until repaired;
- service names and every protocol alias participate in reverse invalidation;
- successful publication atomically promotes the exact matching candidate
  index;
- denied/failed/superseded candidates never promote;
- a crash after publication but before promotion forces safe baseline rebuild.

### 16.5 Build-gate integration tests

- sandbox `getBuildReport` returns method-level `authority` diagnostics;
- protected-main candidate validation rejects those diagnostics through the
  existing typed `BuildGateFailedError`;
- the same exact candidate passes after an intentional manifest edit;
- builds never modify that manifest;
- provider-only edits can reject an unchanged consumer;
- diagnostics survive service-schema serialization.

### 16.6 Performance tests

Instrument and assert:

- no authority catalog extraction during server startup;
- no authority catalog extraction merely from opening the chat panel;
- one extraction per unique provider catalog key under concurrent reports;
- cached consumer summaries avoid reparsing unchanged units;
- external dependency summaries are reused by content digest and epoch, while
  changed dependency bytes are reanalyzed;
- a verified persisted baseline avoids full reanalysis after restart;
- an epoch change performs one lazy complete baseline before incremental
  publication checks;
- a provider change rechecks only its authority consumers plus ordinary package
  dependents;
- state and provider caches remain within configured bounds.

Avoid brittle absolute wall-time assertions in ordinary CI. Use operation
counters and controlled benchmark coverage, supplemented by a recorded local
before/after profile for the protected-push path.

### 16.7 End-to-end system tests

Following the repository system-test procedure:

1. Run doctor and repair infrastructure first.
2. Run the smallest protected-main publication scenario where a consumer calls
   a userland protected method without declaring its family.
3. Inspect the full run and trajectory on any non-zero result.
4. Verify the diagnostic reaches the agent through automatic build/typecheck
   feedback.
5. Edit the manifest inside the sandbox, rebuild, and push successfully.
6. Change only the provider from open to protected and verify the unchanged
   consumer is rejected.
7. Run the category and smoke suites after the focused scenario passes.

## 17. Observability

Add bounded debug events or structured counters for:

- consumer fact cache hit/miss;
- provider catalog cache hit/miss;
- provider catalog extraction duration;
- authority index composition duration;
- number of providers and consumers touched;
- number and bytes of first-party/workspace/external executable modules
  analyzed versus served from summary cache;
- number of static calls resolved, expanded dynamically, or unresolved;
- affected-unit additions attributable to provider authority changes;
- candidate-index promotions, discarded promotions, and baseline rebuilds
  caused by state/epoch mismatch.

Do not log source text, method arguments, resource handles, credentials, or
full workspace trajectories. Diagnostics may include repository-relative file
positions and public capability/provider identifiers.

These measurements are diagnostic only. They must not become authority facts
or alter build results.

## 18. Security and correctness review checklist

Before landing:

- [ ] All provider and consumer inputs come from the same exact state.
- [ ] No active runtime build or mutable checkout is consulted.
- [ ] Catalog extraction and runtime receiver declarations share one source.
- [ ] Cached consumer facts contain symbolic call results only; provider handle
      identity is added during exact catalog composition.
- [ ] The exact executable module closure includes bundled/executed external
      dependency implementation bytes, not only their types.
- [ ] External dependency summaries are keyed by content digest and epoch and
      use the same fact IR as workspace code.
- [ ] Reusable provider catalogs contain no state hash; exact state lives in
      the resolution wrapper.
- [ ] Service principals and effective method access are preserved.
- [ ] Host-owned effects on workspace RPC fail as provider-contract errors.
- [ ] Missing/invalid provider authority fails closed.
- [ ] Missing literal services and methods are contract errors, never empty or
      open effects.
- [ ] Unknown service identity is visible, not silently ignored.
- [ ] Open methods do not inflate manifests.
- [ ] Protected methods preserve exact tier and resource semantics.
- [ ] Service resolution and service invocation are distinct effects with the
      exact runtime-selected resources.
- [ ] Runtime and analysis share canonical service-operation, receiver, and
      handle resource codecs.
- [ ] Known opaque-handle provenance flows into protected arguments; unknown
      provenance is conservative and visible.
- [ ] Static handle compatibility covers workspace, definition digest,
      provider, receiver source/class/object key, and resource type.
- [ ] Exact bindings include the reviewed service presentation used by approval
      copy.
- [ ] Package provenance follows the explicit first-party/dependency rules.
- [ ] Provider-bound wildcard matching cannot cross provider or local-name boundaries.
- [ ] Static inference never writes manifests or grants.
- [ ] Runtime receiver enforcement remains unchanged and load-bearing.
- [ ] Provider updates revalidate unchanged consumers.
- [ ] Removed edges are caught through the published/candidate union.
- [ ] Every service name and protocol alias participates in reverse invalidation.
- [ ] Incremental selection requires a complete baseline for the current
      analyzer/schema epoch.
- [ ] Persisted baseline completeness is content-addressed and verified.
- [ ] Baseline diagnostics remain affected until their current-epoch reports
      pass.
- [ ] A candidate index becomes published only after a matching successful
      protected-publication event; stale or failed candidates never promote.
- [ ] Service cycles do not enter the package DAG.
- [ ] Caches are bounded, content-addressed, and never authorization inputs.
- [ ] Initial chat startup performs no eager authority indexing.

## 19. Definition of done

This work is complete when all of the following hold:

1. Installed code calling a protected userland RPC method cannot pass its exact
   build report without a covering service request and provider-bound method
   capability request.
2. Open userland methods require no method-level manifest noise.
3. Provider-only authority changes deterministically recheck unchanged
   consumers and can block protected `main`.
4. Candidate and published service relationships are both considered.
5. Missing services/methods and inaccessible code paths are distinguished from
   manifest coverage failures.
6. Dynamic calls are either finitely expanded or reported as unbounded.
7. Service resolution, service invocation, receiver-object effects, and
   opaque-handle effects use shared runtime/static resource projections.
8. Provider-independent facts remain reusable across provider changes, while
   exact composition resolves producer results into complete handle bindings.
9. First-party, workspace-package, and external executable dependency bytes are
   analyzed through one fact model.
10. Package-origin effects require the explicitly routed dependency endowment.
11. A complete current-epoch baseline exists before incremental protected-main
   selection, including all service-name and protocol aliases.
12. Successful publication atomically promotes its exact candidate index;
    crashes or mismatches safely require baseline reconstruction.
13. Checkout auditing, manifest proposal tooling, and exact-state build feedback
   use the same inference and coverage implementation.
14. The runtime bundle key is not churned by diagnostic-only provider changes.
15. No new startup or initial-chat work is introduced.
16. Focused, category, smoke, authority-audit, host typecheck, and userland
   typecheck coverage pass.
17. Obsolete handwritten userland effect mappings are deleted.

## 20. Explicit non-goals

- Proving arbitrary JavaScript or replacing runtime enforcement.
- Predicting authority for future agent-evaluated code.
- Automatically approving, granting, or editing authority.
- Adding userland service relationships to package build ordering.
- Rebuilding consumer artifacts solely because provider authority changed.
- Granting a whole human-facing authority domain as one capability.
- Treating documentation catalogs as runtime authorization evidence.
- Supporting unconstrained service-name reflection by silently broadening a
  manifest to the entire workspace.

# Agent tool and API discoverability handover

Status: implementation-ready proposal, validated against the current host and
external Base on 2026-08-14.

## Outcome

Improve agent authoring success by completing the discovery and diagnostic
paths Vibestudio already has:

1. `help("binding.method")` shows an exact callable example as well as the
   current argument, result, access, error, and related-method metadata.
2. RPC argument validation identifies the method parameter by name instead of
   reporting only tuple position `[2]`.
3. Build diagnostics for the two recurring declaration mistakes carry a
   stable code and a machine-readable repair, while retaining the existing
   human message and suggestion.
4. Every shipped scaffold is continuously proven to pass the canonical build
   verifier before an agent customizes it.

This is deliberately not a new discovery subsystem. It does not add a second
preflight compiler, per-handle reflection methods, fuzzy runtime behavior,
weaker TypeScript settings, or automatic authority grants.

## Motivation and observed failures

The targeted agentic campaign found a repeated pattern: the agent's product
intent was reasonable, but it guessed a platform contract and learned the
exact contract only after a full authoring step.

Representative failures were:

- an application Durable Object declared an arbitrary
  `vibestudio.durable.classes[].rpcSchema` and received “unknown workspace RPC
  schema”; application protocols actually belong in
  `meta/vibestudio.yml services[].protocols` and the class must omit
  `rpcSchema`;
- a panel called a declared workspace service without the exact
  `workspace-service:<name>` authority request;
- runtime calls failed with Zod paths such as `[2]`, for example a nullable
  value reaching the third `indexPanel` or `search` argument, without naming
  what that argument represented;
- agents guessed unsupported runtime operations before eventually finding the
  correct live surface;
- freshly generated React panels previously carried dependency declarations
  that did not match the Base runtime.

Strict verification was useful in all of these cases. The defect is not that
the verifier rejected invalid code. The defect is that the canonical contract
was less accessible than a plausible guess, and some failures described the
wire representation rather than the author-facing call.

## What already exists and must remain canonical

The implementation must extend these paths rather than route around them.

### Live runtime help

`packages/builtin/src/eval-engine/evalSurfaceHelp.ts` already reflects the live
injected binding, filters out hidden wire methods, and supports:

```ts
await help();
await help("vcs");
await help("vcs.edit");
```

Per-method help already projects argument and return schemas plus `access`,
`errors`, and `seeAlso`. `MethodSchema` already supports worked `examples`, but
`describeEvalMethod` currently drops them. This is a small, concrete gap.

### Caller-filtered capability catalog

The `docs` service already provides search, description, raw schema, and
service listing. It filters entries to the caller-visible surface and carries
examples. It is the correct source for discovery outside an eval binding.

### Canonical build report

`services.build.getBuildReport(unit, ref)` already performs the complete
compiler, bundler, manifest, workspace-RPC, and static-authority validation.
The agent `verify({ operation: "build", target })` tool calls this exact method,
bounds its diagnostics, and returns a reusable failure receipt. It is already
the fast local repair loop and the protected publication gate repeats the same
check against the candidate.

Consequently, a new `verify:preflight` operation would be a second name and
contract for the same result. Do not add it.

### Canonical scaffolding

`skills/workspace-dev/create-project.ts` in Base owns panel and worker
scaffolds. It now pins the exact React runtime expected by Base and the
`durable-service` scaffold deliberately omits `rpcSchema`. These invariants
need acceptance coverage, not another generator.

## Scope

### Work package 1: complete per-method `help`

#### Change

Project the existing `MethodSchema.examples` field through serialized service
descriptions and `describeEvalMethod`. Render the first example as an exact
call and retain the bounded structured examples for callers that need more
than one.

Do not infer examples from prose. The method definition remains the literate
source of truth.

Suggested result shape:

```ts
{
  name: "docs.search",
  surface: "injected-runtime-method",
  call: "await docs.search(query, options)",
  parameters: [
    { name: "query", type: "string" },
    { name: "options", type: "{ surface?: ...; limit?: integer } | undefined" }
  ],
  returns: "...",
  examples: [
    {
      call: "await docs.search(\"store a blob and get a digest\", { limit: 5 })"
    }
  ],
  errors: [],
  seeAlso: []
}
```

The exact JSON shape may reuse the existing `MethodExample` representation;
the invariant is that it survives end to end and the rendered call is valid.

#### Argument names

Add optional `argumentNames?: string[]` to `MethodSchema`. This metadata belongs
beside the Zod tuple because a tuple schema does not retain source parameter
names. Enforce at definition/serialization test time that its length equals the
maximum tuple length.

Where metadata is absent, preserve the current `input`/`arg0` fallback. Add
names first to the small, agent-facing runtime methods and services involved in
common authoring flows; do not require an atomic repository-wide annotation.
The first required set is:

- `docs.search`, `docs.describe`, and `docs.getSchema`;
- `build.getBuildReport`;
- the public `panelTree` operations;
- `workers.resolveService`, `workers.resolveDurableObject`, and worker creation;
- the workspace-state presentation methods called by panel runtime code.

#### Host files

- `packages/shared/src/typedServiceClient.ts`
- `packages/service-schemas/src/docs.ts`
- affected service schema modules for the required first set
- `src/server/services/catalog/serialize.ts`
- `packages/builtin/src/eval-engine/evalSurfaceHelp.ts`
- corresponding focused tests

If Base carries a copied wire type for serialized docs entries, update it from
the host schema rather than introducing a Base-only shape.

#### Acceptance

- `help("docs.search")` uses `query` and `options`, never `arg0`/`arg1`.
- Its documented example can be executed unchanged.
- Existing ergonomic overrides such as `fs.open` still win over raw wire
  descriptions.
- Binding-level help remains compact and does not return every nested schema.
- Hidden wire methods remain absent.

### Work package 2: name invalid RPC arguments

#### Change

At the single service argument-validation boundary, translate a leading numeric
Zod issue path through the method's `argumentNames`. Preserve the original
machine path and issue list, but add author-facing fields and text.

Example:

```json
{
  "code": "invalid_type",
  "path": [2],
  "parameter": "options",
  "parameterPath": ["options"],
  "message": "Expected object, received null"
}
```

Rendered error:

> Invalid arguments for indexPanel: parameter `options` received null; expected
> object. Omit the optional value or pass an object.

Only add the final omission hint when the schema proves the tuple position is
optional. Do not guess method-specific repairs in the generic validator.

#### Files to locate and change

- the shared service dispatcher/state argument validator that currently emits
  `Invalid arguments for <method>: <Zod issues>`;
- the serialized method definition passed to that validator;
- focused dispatcher/state-validation tests;
- runtime relay tests proving the enrichment survives DO and main-service
  errors.

There must be one formatter. Do not separately format Electron, server, DO,
and eval failures.

#### Acceptance

- a third-argument `null` error reports both original path `[2]` and the named
  parameter;
- nested paths become `options.foo`, while retaining `[2, "foo"]`;
- methods without `argumentNames` retain current behavior;
- no successful dispatch behavior or validation strictness changes.

### Work package 3: structured repairs for declaration diagnostics

#### Change

Extend `UnitBuildDiagnostic` with optional, bounded agent metadata:

```ts
type AgentDiagnosticRepair =
  | {
      code: "application-protocol-declaration";
      remove: { file: string; field: string };
      declareAt: {
        file: "meta/vibestudio.yml";
        field: "services[].protocols";
      };
      docsId: string;
    }
  | {
      code: "missing-authority-request";
      file: string;
      field: "vibestudio.authority.requests";
      request: AuthorityRequest;
      docsId: string;
    };
```

Use the existing exact authority fold's `suggestedRequest`; it already computes
the narrow capability, resource, tier, evidence, and provider package. Do not
recompute or broaden it in the harness.

For the unknown `rpcSchema` diagnostic, attach the exact removal field and the
canonical workspace declaration location. Keep the existing explanatory text.

Add the metadata to the existing build report and receipt. `verify` should
pass it through after applying the same size bounds as other diagnostic data.
It should not edit files, grant authority, or automatically retry.

#### Host files

- the canonical build diagnostic wire type in service schemas/build types;
- `src/server/buildV2/workspaceRpcSchemas.ts` and its two diagnostic call sites;
- `src/server/buildV2/authorityFold.ts`;
- build report serialization/bounding tests.

#### Base files

- `packages/harness/src/tools/verify.ts` and focused tests only as needed to
  preserve/render the host-provided repair;
- workspace-development documentation should demonstrate consuming the repair,
  not duplicate its construction rules.

#### Acceptance

- the unknown application protocol failure names the exact field to remove and
  exact canonical declaration location;
- a missing workspace-service request includes the same narrow request that the
  authority analyzer used to decide failure;
- the request is explicitly described as a request, not a grant;
- changing source and rebuilding remains the only recovery; unchanged retries
  remain discouraged by the existing receipt.

### Work package 4: scaffold-to-verifier contract tests

#### Change

Add an assembled acceptance suite that creates each supported default scaffold
in a temporary semantic workspace and feeds it to the canonical build report.
At minimum cover:

- default React panel;
- default stateless worker;
- `durable-service` worker plus a workspace-level application protocol
  declaration;
- one panel consuming that service with the exact authority request.

Assert zero build diagnostics before customization. Also retain focused source
assertions for exact dependency ownership and absence of application
`rpcSchema`.

This suite may use the real Build V2 fixture harness. It must not duplicate
compiler flags in a lightweight mock, because the failure class being guarded
is drift between scaffold output and the real build.

#### Base files

- `skills/workspace-dev/create-project.test.ts` for fast structural assertions;
- a Build V2-backed integration test in the existing workspace-development or
  userland build test location.

#### Acceptance

- every scaffold produced by the public `createProject` path builds cleanly;
- exact React/ReactDOM versions are sourced from one Base-owned constant or
  tested against Base's declared runtime versions;
- the service consumer example includes the narrow authority request from its
  first generated version;
- no test weakens `noPropertyAccessFromIndexSignature` or any shared strict
  TypeScript option.

## Explicit non-goals

### No separate preflight operation

`build.getBuildReport` already is the complete, cached, non-publishing
pre-commit check. A second operation would create drift and teach agents two
names for one boundary. Improve its latency or diagnostics in place if evidence
shows a problem.

### No `capabilities()` method on every handle

Live `help()` and the caller-filtered docs catalog already own reflection.
Adding reflection methods to panel, worker, service, and other handles would
pollute product APIs and still need a central schema source.

### No `help(error)` object protocol in this slice

Agent tool failures already carry typed retry and recovery policy; build
diagnostics already carry messages, suggestions, receipts, and full-report
requests. Passing arbitrary error objects into `help()` would require another
cross-layer error identity protocol. Structured diagnostic repairs close the
observed gap more directly. Reconsider only if evidence later shows stable
diagnostic codes are insufficient.

### No automatic repairs or grants

Discovery may provide exact edit data. It must not mutate manifests, grant an
authority request, publish source, or rerun verification. The agent remains
responsible for making and reviewing the source change.

### No weaker authoring type check

Do not disable `noPropertyAccessFromIndexSignature`, strict null checks, or the
authority analyzer. Scaffolds and examples must satisfy the production
contract.

### No speculative telemetry project

The system-test trajectory already records tool calls, failures, and recovery.
Use those artifacts for later evaluation. Do not add a second production event
pipeline as part of discoverability.

## Implementation order

1. Add `argumentNames` and complete example serialization/projection.
2. Use `argumentNames` in the single validation-error formatter.
3. Add structured repairs to the two proven build diagnostic classes.
4. Add the scaffold-to-real-verifier acceptance suite.
5. Run the smallest focused conventional tests after each package.
6. Run only the exact agentic tests that exercise a behavior changed by that
   package. Do not rerun successful long workflows for validator-only changes.

The packages are intentionally independently shippable. Work package 1 improves
prospective discovery; package 2 improves call correction; package 3 improves
source repair; package 4 prevents the platform's own starting point from
drifting.

## Verification matrix

### Conventional

- eval surface help unit tests;
- docs catalog serialization and caller filtering tests;
- service dispatcher argument-validation tests;
- Build V2 workspace RPC and authority-fold diagnostics tests;
- verify-tool report bounding/receipt tests;
- real Build V2 scaffold acceptance tests;
- host and all three Base semantic type checks.

### Exact agentic tests

Use fresh managed system-test instances only where Base changes require a fresh
template. The minimum behavioral cases are:

1. ask the agent to inspect and call an unfamiliar two-argument live method;
   it should use named help and call it without guessing;
2. intentionally pass `null` to a named optional-object parameter; the next
   attempt should correct the named parameter without repository search;
3. create an application Durable Object service; an intentional bad
   `rpcSchema` declaration should be repaired using the diagnostic metadata;
4. create a service-consuming panel; an intentional missing authority request
   should be repaired with the supplied narrow request;
5. create and build an unmodified default panel and durable-service scaffold;
   both should pass on the first build.

Do not require a completely failure-free creative application run as the
acceptance criterion for these changes. Each case should isolate the discovery
contract it is intended to prove.

## Completion criteria

This work is complete when:

- live per-method help exposes existing examples and names the required common
  arguments;
- invalid argument failures identify author-facing parameters while preserving
  exact machine paths;
- the two observed declaration failures provide bounded structured repairs
  derived by their canonical analyzers;
- all public default scaffolds pass the real canonical build report unchanged;
- generated runtime docs/catalog parity tests prevent metadata drift;
- no parallel compiler, reflection API, automatic grant, compatibility path,
  or relaxed type rule was introduced.

## Expected effect

This does not attempt to make agents infallible. It removes four avoidable
sources of wandering:

- method signatures hidden behind plausible guesses;
- positional errors without semantic parameter names;
- declaration failures that explain policy but leave the exact edit implicit;
- starting templates that can drift from the verifier they are meant to
  satisfy.

Those improvements are supported directly by failures observed in the current
campaign and by extension points already present in the codebase. They are the
smallest confident discoverability investment before considering broader
agent-behavior changes.

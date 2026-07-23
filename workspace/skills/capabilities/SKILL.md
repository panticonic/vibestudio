---
name: capabilities
description: Design, declare, discover, and debug Vibestudio capabilities and dynamic intra-workspace services without confusing manifests, grants, approvals, or generated audit catalogs.
---

# Capabilities and workspace services

Read this skill before adding a host-service effect, a worker or Durable Object API,
an authority request, or a workspace-owned approval flow.

When changing host enforcement, mission closure, seeded product authority, or the
System Agent boundary, also read
[`references/authority-implementation-checklist.md`](references/authority-implementation-checklist.md).
It names the review inputs and tests that must move together.

## The four things that must stay separate

1. A **method contract** says which authenticated principals may call a method, its
   tier, its receiver requirements, and how its concrete resource is derived.
2. A unit's checked-in **authority manifest** is the maximum authority that exact
   source artifact requests. A request is intent, never permission.
3. A host **grant or fresh approval** authorizes an eligible request. Open methods do
   not need a grant; gated methods intersect requests with grants; critical methods
   require a fresh approval for every exercise.
4. A workspace service's **userland approval** answers a policy question owned by
   that service. It cannot authorize host effects such as egress, credential use,
   protected publication, or external browser opens.

Never turn discovery, a build, generated documentation, a static code census, or an
observed invocation into a grant. Generated authority ledgers are review/audit evidence
only; editing or regenerating one is not capability approval. Workspace code admission
comes from a human decision over the exact sealed version and manifest, not a generated
product catalog.

## Dynamic workspace capabilities

Workspace-built services are discovered from the exact caller's live semantic
workspace context. They are not limited to a startup scan or a checked-in global
census.

### Agent authoring loop: keep docs outside eval

`docs_search` and `docs_open` are agent tools. They are **not** globals or exports
inside `eval`; `docs`, `docs.search`, and `docs.open` are undefined there. Use this
order after editing a provider:

1. Call the agent tool `workspace_service` with `operation: "upsert"`. It writes
   the `services` row and, when `transport.objectKey` is present, the matching
   `singletonObjects` row as one schema-validated semantic edit. Do not splice
   either YAML list with generic `edit`/`write`; a singleton is launchable
   infrastructure, not a discoverable service by itself.
2. Call the agent tool `docs_search` for the new service name or protocol. If the
   row is absent, stop: the declaration is missing or invalid in the current
   context. Re-read the relevant YAML and repair it. Do not start eval and do not
   guess a route.
3. Call the agent tool `docs_open` for the service and exact method. Only after it
   reports the expected live provider version and method should you start eval.
4. Inside eval, use only the documented runtime exports:

```ts
import { workers, rpc } from "@workspace/runtime";
const service = await workers.resolveService("example.protocol.v1");
if (service.kind !== "durable-object") throw new Error("Expected a Durable Object service");
return rpc.call(service.targetId, "methodName", []);
```

Import only runtime values that the eval actually uses. TypeScript's `type`
keyword is a modifier for a real imported type name, not an export named
`type`; never write `import { workers, type } from "@workspace/runtime"`.

There is no polling delay in this sequence. A docs result is the read-after-edit
proof that the current semantic context can build and describe the declaration;
absence is a concrete authoring diagnostic, not eventual success to wait for.

- Declare a service with `workspace_service`, supplying a stable protocol,
  source, user-facing title/action/description, principals, and transport.
- Use the agent tools `docs_search` / `docs_open` to inspect the live
  caller-visible contract before starting an eval. These are tool names, not
  `@workspace/runtime` exports. Inside eval, consume the result through the
  documented `workers.*` and `rpc.*` runtime APIs. Service and API docs are
  generated from the same exact declaration set used for resolution. Never
  reference `docs` from eval code.
- To enumerate services before you know a name or protocol, call
  `docs_search({ query: "", surface: "workspace" })`. Open one of the returned
  IDs; do not search source files or another unit's manifest to reconstruct the
  live service registry.
- `workers.listServices()` is the lightweight runtime enumeration. Each
  workspace-owned row carries its `docsId`; open that id with `docs_open` before
  choosing a receiver method. This is the same live catalog, not a second census.
- Tool calls use the strict shapes `docs_search({ query: "...", surface?, limit? })`
  and `docs_open({ id: "workspace:<service>[.<method>]" })`. Do not pass filesystem
  `path` fields or copy search fields into `docs_open`.
- Resolve by protocol with `workers.resolveService(protocol, objectKey?)` or
  `workers.resolveDurableObject(source, className, objectKey)`, then call the returned
  target through `rpc.call` or a typed client.
- Resolution, direct-RPC authority, and provider identity are bound to the same caller
  context and exact provider effective version. A declaration visible in another
  context does not authorize or resolve in this one.

Do not add workspace service names to a generated product catalog. Static reviewed
censuses are appropriate for static host/product capabilities; workspace-built units
must remain live, context-relative declarations.

The provider method roster and source signatures in live docs are derived during the
exact context build and sealed with that build's effective version. This metadata is
documentation only: it neither requests nor grants authority, and the receiver's live
`@rpc` declaration independently remains default-deny. A missing method contract is a
provider documentation defect to fix, not a reason to guess from source.

An installed unit that knows a service contract requests the exact
`workspace-service:<name>` capability in its reviewed manifest. Agent eval is different:
its reviewed `workspace-service:*` ceiling only says that a task may encounter a service
which did not exist when the harness was built. The wildcard is not a grant. The live
declaration chooses the exact service capability and provider EV, and the session grant,
mission closure, context-integrity latch, and any fresh approval still intersect at the
call. Never replace that live selection with a generated list of today's service names.

The shortest authoring loop is:

1. Add the worker/DO method and its `@rpc` receiver contract.
2. Add the context-local singleton/service declaration to `meta/vibestudio.yml`.
3. Ask live docs for the protocol you just declared; this proves that documentation and
   resolution see the same semantic context.
4. Resolve the protocol and call the returned target. Do not guess a source/class/key
   route or edit an authority catalog.

`workspace-service` describes a declared service boundary, not every method on
every workspace Durable Object. A disposable object intentionally addressed by
source/class/key through `workers.resolveDurableObject(...)` instead declares
`effect: { kind: "runtime-intrinsic" }`. The two routes fail closed when mixed:
a raw target cannot exercise a receiver method declared as a workspace service,
and changing the receiver effect merely to bypass a missing service declaration
is not an authority fix. Add the live service declaration and use
`resolveService(...)`, or keep the object explicitly lifecycle-owned and direct.

### Installed provider/consumer recipe

When the **consumer is installed workspace code** (rather than eval), use this
complete shape. The provider is a context-local Durable Object service and the
consumer is an ordinary disposable worker.

If a suitable service is already present, discover it through live docs and
start at the consumer manifest/code below; do not create a duplicate provider
or edit `meta/vibestudio.yml` merely to demonstrate consumption.

Provider receiver (`workers/local-greeting/index.ts`):

```ts
import { DurableObjectBase, rpc } from "@workspace/runtime/worker";

export class LocalGreetingDO extends DurableObjectBase {
  protected createTables(): void {}

  @rpc({
    principals: ["code"],
    effect: { kind: "workspace-service" },
    tier: "open",
    sensitivity: "read",
  })
  async greet(): Promise<{ greeting: string }> {
    return { greeting: "hello from the local provider" };
  }
}
```

Live declaration (`meta/vibestudio.yml`):

```yaml
singletonObjects:
  - source: workers/local-greeting
    className: LocalGreetingDO
    key: main
services:
  - source: workers/local-greeting
    name: local-greeting
    protocols: [example.local-greeting.v1]
    authority:
      principals: [code]
    durableObject: { className: LocalGreetingDO }
```

Consumer manifest fragment (`workers/local-consumer/package.json`):

Manifest request tiers are only `"gated"` and `"critical"`. Do not copy the
provider method's `@rpc` tier `"open"` into the manifest: receiver policy and
requested authority are intentionally different layers.

`requests` and `evalCeilings` are independent. The examples show both for a
fully explicit reviewed manifest, but an omitted section normalizes to an empty
fail-closed list. Unknown fields and malformed entries are always rejected.

```json
{
  "vibestudio": {
    "authority": {
      "requests": [
        {
          "capability": "workspace-service:local-greeting",
          "resource": { "kind": "prefix", "prefix": "" },
          "tier": "gated",
          "evidence": "bounded-dynamic"
        }
      ],
      "evalCeilings": []
    }
  }
}
```

Consumer receiver (`workers/local-consumer/index.ts`):

```ts
import {
  createWorkerRuntime,
  handleWorkerRpc,
  type ExecutionContext,
  type WorkerEnv,
} from "@workspace/runtime/worker";

let exposedFor: string | null = null;

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    if (exposedFor !== env.WORKER_ID) {
      runtime.rpc.expose("consumeLocalService", async () => {
        const service = await runtime.workers.resolveService("example.local-greeting.v1");
        if (service.kind !== "durable-object") throw new Error("Expected local DO service");
        return runtime.rpc.call(service.targetId, "greet", []);
      });
      exposedFor = env.WORKER_ID;
    }
    return handleWorkerRpc(runtime, request) ?? new Response("ready");
  },
};
```

The low-level installed-worker `runtime.rpc.call(...)` returns `unknown` unless
the caller supplies a documented result type or uses a typed client. For a
smoke/proof endpoint, return the provider result intact instead of guessing and
projecting fields. If application code needs individual fields, define or
import the provider's public result contract and call
`runtime.rpc.call<ThatResult>(...)`; do not infer a shape from a method name.

Build both units in the same context, ask live docs for
`example.local-greeting.v1`, then exercise the installed consumer through the
normal typed lifecycle. This complete eval shape keeps the build selector,
runtime context, RPC target, and cleanup aligned:

```ts
import { contextId, rpc, workers } from "@workspace/runtime";

const source = "workers/local-consumer";
const report = await services.build.getBuildReport(source, `ctx:${contextId}`);
if (report.status !== "ok") return report;

const handle = await workers.create(source, {
  key: `probe-${crypto.randomUUID()}`,
  contextId,
});
let observed: unknown;
try {
  observed = await rpc.call(handle.targetId, "consumeLocalService", []);
} finally {
  await workers.destroy(handle);
}
return { observed, createdId: handle.id, retiredId: handle.id };
```

Do not replace `services.build.getBuildReport` with an invented helper or raw
`runtime.createEntity`: the explicit build selects the context-local artifact,
and `workers.create` carries that same context through the canonical lifecycle.
The installed request remains only a maximum: the exact live
declaration/provider EV and the ordinary grant or approval path must still admit
the call.

The provider DO and regular-worker consumer may also live in **one worker
package**. Export the DO class and the default worker `fetch` handler from the
same entry file, list that class under `vibestudio.durable.classes`, point the
singleton/service declaration at that same package source, and keep the exact
`workspace-service:<name>` request on the package. Prefer this shape when a task
already owns one disposable worker repository; do not create a second repository
only to imitate the two-directory illustration above.

## Authoring a unit

For a panel, worker, app, extension, or package that performs gated or critical work:

1. Prefer typed runtime APIs. Use live docs to find the operation and its resource
   shape; do not guess a transport method string.
2. Add the narrow request to that unit's checked-in
   `package.json#vibestudio.authority.requests`. Keep `evalCeilings` separate: a
   ceiling only limits evaluated child code and grants nothing.
   Add requests only for gated or critical effects. Open methods and host-owned
   runtime lifecycle plumbing are deliberately absent; putting either in a manifest
   is an error because neither is discretionary unit authority.
3. Use the narrowest resource supported by the operation: exact identity, origin,
   domain, or a deliberate prefix. A bare prefix is slash-hierarchical
   (`context` covers `context/panel`, not `contextual`). End a lexical dynamic
   namespace with its separator when names share a reviewed stem
   (`projects/system-test-` covers generated system-test names only). Do not use
   a wildcard to silence a build error.
4. Run an explicit build/typecheck against `ctx:<contextId>`. The build compares and
   seals the reviewed manifest; it must never rewrite it.
5. Exercise the path. If authority is absent, let the typed acquisition flow explain
   or request it. Do not catch `EACCES` and retry through another service, caller, or
   host identity.

Changing code invalidates version-bound grants because authority follows the exact
execution digest. Critical authority is never persistent.

An agent-owned eval is a conduit, not a separately trusted app. A durable delegated
choice is **Trust this agent** and remains keyed to that exact agent identity. This is
not an installed-code update or version decision at all. Every eval still receives its
own code review before it can run, and its effects still intersect the owning agent
worker's sealed execution identity, manifest ceiling, mission, and context.

## Review and activation lifecycle

Executable workspace units are reviewed as exact build identities, not by package
name alone. The identity includes the unit's source effective version, transitive
workspace dependency versions, relevant external dependency versions, runtime ABI,
and its complete sealed authority contract: direct `requests` plus every
purpose-specific `evalCeilings` entry. Eval ceilings are reviewed limits on code
the unit may evaluate; they are not grants to perform those effects.

- On a fresh workspace, every executable version already present—apps, native
  extensions, panels, workers, and userland Durable Objects owned by those workers—is
  collected into one startup batch when it lacks prior admission. This is one user
  decision with many progressively disclosed unit rows, not one prompt per capability
  or per host. The selected host app owns the bootstrap surface, but it does not approve
  itself: the host resolves the entire batch before activating that exact app version.
- A protected-main publication that changes an executable unit or anything in its
  transitive build closure presents one combined source-and-authority review before
  the head advances. The exact candidate identities accepted by that decision are
  handed directly to activation; activation must not ask the same question again.
- Shared libraries do not receive runtime authority of their own. Changing one changes
  the effective versions of its executable dependents, so those dependent apps,
  extensions, panels, and workers appear in the protected-publication review.
- Added capabilities are shown first in user-facing language. Unchanged capabilities
  stay collapsed under details; removals are summarized. A code-only change therefore
  says that no new permissions are requested without hiding that the exact code version
  is changing.
- Direct unit capabilities and evaluated-code ceilings are sections of this same
  exact-version review, never separate prompts. Each section says which panel, worker,
  app, extension, or package it describes. Added evaluated-code powers are shown first;
  unchanged ceilings remain collapsed. Approval admits the complete version contract,
  but does not turn an eval ceiling into a grant: evaluated code must still pass its
  session envelope and ordinary grant or fresh-approval path.
- A manifest request remains only a maximum. Version review admits the exact installed
  unit to use that maximum at gated tier; action-scoped resources, credentials,
  outside-content trust, and critical operations can still require their own just-in-time
  decision. Those are different consent objects, not duplicate version prompts.
- Denied or dismissed unit versions never activate. A later source edit produces a new
  identity and a new review; no session-duration source-change bypass exists.

Do not add a second approval around build completion, host startup, or runtime
activation. If an exact version was reviewed at protected publication, propagate that
identity through the canonical trust handoff. If it was not reviewed (for example an
existing unit in a newly created workspace), enqueue it in the shared startup batch.

An exact `workspace-service:<name>` request is allowed even when that provider is not
present in the checkout being built. This is an intentional dynamic bound, not an
unused request: the live semantic context supplies the declaration and exact provider
EV later. Installed units may not request `workspace-service:*`; that wildcard exists
only in a reviewed eval ceiling.

## Userland-owned approval

Use `userlandApproval` only when workspace code owns the policy question, such as
whether a subject may use a custom service. Supply a stable choice and exact subject;
the host binds the issuer to the calling code identity and persists the decision in
the unified authority grant store. Session decisions survive host restart and expire
with the authority session; version decisions bind to the issuer repository and exact
effective version.

Do not use userland approval as a proxy for credentials, network access, filesystem
authority, protected-main publication, panel control, or another host capability.
Those effects must pass their ordinary receiver and host grant checks as well.

## Content integrity

Content provenance is authority input. File versions and durable channel messages are
stamped at their write chokepoints from the authoring session's monotone latch. Reads
advance the receiving session's latch before bytes become visible. Never accept a
caller-supplied `contentClass` or `externalKeys`, and never copy content through a new
file or message to make it appear internal.

If an otherwise valid standing grant is refused after outside content entered the
session, use the authority preflight/approval explanation. The outside lineage is a
fact to preserve, not an error to erase.

## Mission closure

A mission is an immutable, content-addressed authority closure, not a label attached
to an agent. Its charter binds the exact harness EV, hashed skills, exposed host and
workspace services, model settings, trigger, and network policy. Starting a mission
session is allowed only while that exact closure is active.

- Change any closure input by creating a revised mission and obtaining approval for
  that exact revision. Do not mutate a running session or repair a digest in place.
- Preserve the original mission, session, caller, owner, and context lineage through
  every service and RPC leg. A host caller substituted for a failing internal leg is
  an authority escalation.
- Treat standing restrictions as durable deny grants. A later allow, broader manifest,
  or acquisition decision cannot override them.
- Resolve pinned userland providers to exact EVs before approval. A `follow-head`
  provider is an explicit closure policy, not permission to silently widen its methods
  or capabilities.
- Use `workspaceServiceDiscovery: "live-declarations"` only for a reviewed mission
  whose purpose genuinely spans services created after approval. It admits live
  declaration selection into the closure; it grants no service capability. The exact
  provider EV, manifest eval ceiling, session grant/acquisition, receiver policy, and
  context integrity still intersect at each call.
- Keep event triggers inside the closed filter grammar. Do not evaluate workspace
  expressions as trigger policy.

Host-shipped seeded missions are reconciled from immutable product snapshot outputs.
Their checked-in JSON is explicit reviewed input; `@seed` is resolved only from the
shipped snapshot. Product reseeding makes an old closure inert before replacing its
grants. Never derive a seed from the mutable workspace tree, and never turn ordinary
workspace code into a product seed.

## Product-owned System Agent

The System Agent is a pinned, product-owned mission and worker, not a privileged copy
of an ordinary workspace agent.

- Its model-facing tool surface remains exactly `eval` and `say`. Shell operations
  happen through typed services inside the ordinary eval runtime.
- Its prompt, handbook, manifest, mission seed, and execution version come from the
  immutable product snapshot. Workspace prompt overrides, skills, memory recall, or
  edited worker code must not widen it.
- Its conversation is host-derived per `(workspace, authenticated user, product
snapshot)`. Callers do not supply user, channel, worker, context, or membership
  identities.
- Its channel has an exact locked roster containing that user and that exact worker
  target. Generic subscription or channel configuration cannot add participants.
- Conversation eval cannot settle approvals, read protected approval payloads,
  activate/renew/widen delegation, alter its own trust root, or extract stored
  credential material. Those require separate human or delegated-policy boundaries.

Do not add a System-Agent-only transport, eval dialect, receiver bypass, or lifecycle
branch. If a shell operation is missing, add the typed semantic service with ordinary
receiver enforcement and review its inclusion in the mission closure.

## Diagnosing a denial

- Search/open the live docs for the exact caller context.
- Confirm the service declaration exists in that semantic context and the resolved
  provider/source is the intended one.
- Distinguish `not requested` from `requested but not granted`, critical fresh
  approval, receiver relationship failure, and outside-content lineage drift.
- Inspect the unit's sealed build metadata and execution digest, not only its mutable
  `package.json`.
- Keep the original caller/session across closure legs. Never replace it with a host
  caller to make an internal leg pass.

Unknown schemas, missing provenance, missing provider declarations, and unclassified
authority fail closed. This is prerelease software: fix the source contract or the
runtime architecture instead of adding compatibility shims or parallel paths.

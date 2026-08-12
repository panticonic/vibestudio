---
name: capabilities
description: Design, declare, discover, inspect, or debug Vibestudio authority and dynamic workspace services without confusing method contracts, unit requests, grants, approvals, live declarations, or generated audit evidence.
---

# Capabilities and workspace services

Read this before adding a host effect, worker or Durable Object API, authority
request, or provider-owned approval boundary. For host enforcement, mission
closure, product seeds, or the System Agent, also read the
[authority implementation checklist](references/authority-implementation-checklist.md).

## Keep the authority layers separate

1. A **method contract** defines admitted principals, receiver/resource
   derivation, effect, sensitivity, and tier.
2. An installed unit's checked-in **authority manifest** is the maximum gated
   or critical authority requested by that exact code. A request is not a
   grant.
3. A host **grant or fresh approval** authorizes an eligible request. Open
   methods need no grant; critical effects require a fresh decision.
4. A workspace provider's **provided capability** protects a resource it owns.
   The receiver enforces it before provider code runs. Downstream host effects
   such as credentials, egress, publication, or browser opening remain
   independently protected.

Discovery, generated docs, builds, code censuses, and observed invocations are
never grants. Generated authority catalogs are review evidence; workspace code
admission comes from a decision over the exact sealed unit and manifest.

## Inspect or acquire authority

Use live docs for `permissions`, `authority.preflight`, and the target service's
current method contract. Permission inventory is a read-only view; modify
decisions only through the owning host surface.

Let the real protected operation enter the normal acquisition path. Do not ask
for authority inside provider code, probe by making a broader call, or retry
through another caller. Use preflight only when knowing the structured outcome
before the effect is useful.

Opaque preparation handles identify provider-owned state; they do not authorize
it. Produce them with the declared handle mechanism and bind consumers to the
matching capability and argument. Never accept or invent a raw selector as a
substitute.

## Author a dynamic workspace service

Workspace services are resolved from the exact caller's semantic context, not
a startup scan or static host catalog.

1. Add the provider method and its explicit `@rpc` receiver contract.
2. Use the `workspace_service` agent tool with `operation: "upsert"` to update
   the service and singleton declaration atomically. Supply the presentation,
   notability, principals, protocol, source, and transport required by its
   schema. Do not splice these YAML lists by hand.
3. Call `docs_search` and `docs_open` as agent tools. Absence is a declaration
   or build diagnostic; do not poll or guess a route.
4. In eval, resolve the documented protocol and call the returned target:

   ```ts
   import { rpc, workers } from "@workspace/runtime";

   const service = await workers.resolveService("example.protocol");
   return rpc.call(service.targetId, "methodName", []);
   ```

`docs_search` and `docs_open` are not eval globals or runtime exports. Live docs
and resolution use the same context-relative declaration and provider build.
Do not source-scan another unit to reconstruct the roster or add dynamic
service names to a generated host catalog.

Use `workers.listServices()` only for lightweight runtime enumeration, then
open the returned docs ID before choosing a method. Use
`resolveDurableObject(...)` only for explicitly lifecycle-owned objects whose
contract is addressed by source, class, and key rather than a discoverable
service.

## Protect provider-owned resources

Declare local capabilities in the provider manifest's `authority.provides` and
bind each protected receiver through its `@rpc` effect or extension method
authority. Use the declared receiver resource for simple values and a prepared
opaque handle for private provider state.

An installed consumer that knows a service requests the exact
`workspace-service:<name>` capability in its manifest. Evaluated code has no
installed-unit manifest ceiling; live selection, task or mission admission,
session grants, receiver policy, context lineage, and content integrity still
intersect at the call.

Do not mark a protected method open to compensate for a missing service
declaration or consumer request. Fix the owning contract.

## Author an executable unit request

For a panel, worker, app, extension, or package that performs gated or critical
work:

1. Find the typed operation and exact resource through live docs.
2. Add the narrow request to
   `package.json#vibestudio.authority.requests`. Do not request open methods or
   host-owned lifecycle plumbing.
3. Use the narrowest exact identity, origin, domain, or intentional prefix. Do
   not use a wildcard to silence a build error.
4. Build or typecheck the exact `ctx:<contextId>` working state. The build seals
   and checks the manifest; it does not write or approve it.
5. Exercise the real path. On denial, follow structured remediation rather than
   catching `EACCES` and trying a parallel route.

Version-bound grants follow the exact execution digest. Shared library changes
therefore affect the reviewed identities of executable dependents. Carry a
reviewed identity into activation; do not add a second approval around build,
startup, or first use.

## Relationship authority

Panel-tree placement is presentation, not authority. Immutable launch ancestry
can prove control over runtimes a panel, its bound agent, or that agent's eval
created. Moving an unrelated panel into a collection does not transfer that
relationship or its context authority.

Do not propagate capabilities through ancestors, descendants, or reparenting.
Have a coordinator spawn resources it should control; otherwise preserve their
provenance and use the exact context-boundary decision.

## Content integrity, missions, and product agents

Content provenance is authority input. The host stamps files and durable
messages at their write boundaries and advances the receiving session's
monotone integrity latch on reads. Never accept caller-supplied content class,
copy content to disguise its origin, or invent/parse lineage-set coordinates.
Use `contextIntegrity.explain` for bounded diagnostics from the current session.

A mission is an immutable authority closure over the exact harness, skills,
services, model, trigger, and network policy. Change closure inputs through a
reviewed mission revision; preserve caller, owner, session, and context lineage
through every leg. Standing restrictions are durable denies, not suggestions.

The System Agent is a product-owned mission with a product-derived worker,
prompt, roster, tools, and execution identity. It uses ordinary typed services
inside eval. Do not add a special transport, receiver bypass, approval channel,
workspace prompt injection, self-grant path, or credential extraction route.
Use the checklist for exact invariants and verification.

## Diagnose a denial

Read the live method and provider contract, then follow the structured reason
and remediation:

| Outcome | Action |
| --- | --- |
| Missing grant or content-lineage decision with user-approval remediation | Let the existing acquisition flow request the exact decision. Retry only after it resolves. |
| Installed code did not request the capability | Add the returned narrow request to the owning manifest and submit a newly sealed unit for review. |
| Receiver is undeclared | Add or repair the provider's reviewed receiver contract. Caller grants cannot authorize it. |
| Principal, relationship, session, attestation, or explicit denial | Treat it as terminal for that invocation and follow its exact remediation. |

Inspect sealed build metadata and execution identity, not only mutable source.
Preserve structured errors and the original caller across internal legs. Unknown
schemas, missing provider declarations, missing provenance, and unclassified
authority fail closed.

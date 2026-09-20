# Context builds and protected publication

Builds consume projected source content; they do not define semantic history.
Protected publication consumes an exact committed event through `vcs.push`.

Load the live VCS skill and service schemas first:

```bash
vibestudio agent skills skills/vibestudio-vcs
vibestudio agent services vcs --json
vibestudio agent services build --json
```

## Build the current context

For a pre-commit check, request the canonical report for the smallest relevant
unit at the exact context ref:

```ts
const report = await services.build.getBuildReport("panels/notes", `ctx:${contextId}`);
```

Discover the live `build.getBuildReport` schema. Its structured diagnostics
combine bundling, TypeScript, and static authority checks, including missing
requests for statically known calls. Read file, line, column, severity, and
message; repair the cited source or manifest through ordinary managed edits
and request a new report. An authority request is not a grant.
`build.getBuild` produces a runtime bundle; it is not this pre-commit check.

Build keys and content digests identify projections and cache entries. Keep VCS
orientation through `vcs.status` and its event/application state nodes.

## Publish a clean committed event

Run focused checks, commit the complete local chain, then call `vcs.push` with
the exact committed event and main event returned by a fresh status read. Push
validates semantic ancestry and integration facts, reruns the exact-candidate
build, TypeScript, and authority gate for affected units and dependents, obtains
approval, and atomically advances protected refs through one durable effect.
The later runtime artifact build is a separate projection.

A refusal advances nothing. Recover by typed code:

- compare and integrate when main advanced or histories diverged;
- repair build, TypeScript, or authority diagnostics, then recommit and push;
- stop for required authorization or approval;
- preserve integrity or host-effect diagnostics.

## Inspect projections after publication

After publication, build subscribers may derive new artifacts from `main`.
Their success or failure does not rewrite semantic publication. Use unit logs,
server logs, panel console, and screenshots for projection and runtime defects.
Activation fails closed: a bad build, validation, or startup stays inactive and
the previous runnable artifact remains selected. Repair it through a new local
application, explicit context check, commit, and publication. Runtime
observations do not replace semantic status, history, or provenance inspection.

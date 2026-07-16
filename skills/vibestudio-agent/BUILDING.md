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

Call the ordinary build service with the smallest relevant unit and the
context ref:

```ts
const result = await services.build.getBuild("panels/notes", `ctx:${contextId}`);
```

For an agent-actionable report, use the live `build.getBuildReport` schema at
the same context ref. Read structured file, line, column, severity, and message
fields; repair the cited source through ordinary managed edits and rebuild.

Build keys and content digests identify projections and cache entries. Keep VCS
orientation through `vcs.status` and its event/application state nodes.

## Publish a clean committed event

Run focused checks, commit the complete local chain, then call `vcs.push` with
the exact committed event and main event returned by a fresh status read. Push
validates semantic ancestry and integration facts, obtains approval, and
atomically advances protected refs through one durable effect. It does not run
or certify a build.

A refusal advances nothing. Recover by typed code:

- compare and integrate when main advanced or histories diverged;
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

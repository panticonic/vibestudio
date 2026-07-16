# CLI recipes

These recipes cover CLI transport and observation. Semantic VCS behavior lives
only in the workspace's `skills/vibestudio-vcs` skill.

## First contact

```bash
vibestudio remote pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2&ice=all"
vibestudio remote status
vibestudio agent attach
vibestudio agent services
vibestudio agent skills
```

## Load the VCS procedure and schema

```bash
vibestudio agent skills skills/vibestudio-vcs
vibestudio agent services vcs --json
vibestudio eval run -e 'return await help("vcs")'
```

Load `file-move-copy.md` before managed identity changes,
`compare-and-integrate.md` before bringing in another context, and
`typed-recovery.md` before retrying an uncertain mutation.

## Explore and edit managed source

```bash
vibestudio fs ls /
vibestudio fs grep "registerPanel" panels/notes -C 2
vibestudio fs read panels/notes/src/index.tsx --out /tmp/index.tsx
# edit /tmp/index.tsx locally
vibestudio fs write panels/notes/src/index.tsx --from-file /tmp/index.tsx
vibestudio vcs status --json
```

Managed content writes create local applications. Use the explicit commands
when identity semantics matter:

```bash
vibestudio vcs move-file panels/notes/src/old.ts panels/notes/src/new.ts
vibestudio vcs copy-file packages/core/src/a.ts packages/core/src/b.ts
```

Use `--dry-run` to resolve transfer identities without mutating. Use a direct
`vcs.edit`, `vcs.move`, or `vcs.copy` call for schema-exact batches.

## Commit or discard the local chain

```bash
vibestudio vcs status --json
vibestudio vcs commit -m "Describe the coherent local work"
# or, when all local work is unwanted:
vibestudio vcs discard
```

Commit and discard always consume the complete local application chain. Create
another session/context when work needs a separate commit boundary.

## Inspect history and provenance

```bash
vibestudio vcs history --limit 50
vibestudio vcs resolve-file panels/notes/src/index.tsx
```

Use direct `vcs.inspect`, `vcs.neighbors`, or `vcs.blame` calls for typed graph
walks. Pass the root returned by the preceding call; do not parse its ID.

## Analyze live data with persistent eval scope

```bash
vibestudio eval run -e '
  scope.entities = await services.runtime.listEntities({});
  return scope.entities.length;
'
vibestudio eval run -e 'return scope.entities.filter(e => e.kind === "panel").map(e => e.id)'
vibestudio eval repl-reset
```

## Create and call a worker

```bash
vibestudio agent call runtime.createEntity '[{"kind":"worker","source":"workers/stats","key":"stats-1"}]'
vibestudio agent call ping --target "worker:workers/stats:stats-1"
vibestudio agent call runtime.retireEntity '[{"id":"worker:workers/stats:stats-1"}]'
```

For a worker or Durable Object, omitted `ref` follows the owning `contextId`'s
semantic working head. Pass `ref: "main"` only when deliberately pinning
protected-main code, or another exact selector when intentionally running a
different semantic state.

## Parallel isolated sessions

```bash
vibestudio agent attach featureA
vibestudio agent attach bugfixB
vibestudio fs write projects/feature-a/note.md --content "task A" --session featureA
vibestudio fs ls / --session bugfixB
vibestudio agent detach featureA --rm
```

Each context has its own committed event and working head. Bring work between
contexts with `compare` and incremental `integrate` decisions; do not copy
projected directories between them.

## Channels

```bash
vibestudio channel list
vibestudio channel history <channelId> --limit 50
vibestudio channel send <channelId> --text "ready for review" --to @alice
vibestudio channel tail <channelId>
vibestudio channel roster <channelId>
```

## Frontend observation loop

Build the edited unit from `ctx:<contextId>`, then inspect it:

```bash
vibestudio panel list
vibestudio panel screenshot <panelId> --out shot.png
vibestudio panel console <panelId> --errors
```

Iterate on structured build and runtime evidence. Commit the complete local
chain and publish only when requested.

## Install this bundled transport skill

```bash
vibestudio agent skill install
vibestudio agent skill install --dir ~/myproj/.claude/skills/vibestudio-agent
```

The bundled transport skill does not embed another semantic VCS protocol.
Fetch the live workspace skill for the maintained procedure.

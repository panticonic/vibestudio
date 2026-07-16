# Files and semantic VCS in a session context

All `vibestudio fs`, RPC, and eval operations run against the attached server
session's context. Remote paths are POSIX-style and workspace-root-relative.
The context folder is a rebuildable projection of the exact working head, not
an independent version-control authority.

## Sessions

```bash
vibestudio agent attach [NAME] [PAIRING_LINK] [--workspace NAME]
vibestudio agent status [NAME]
vibestudio agent sessions
vibestudio agent detach [NAME] [--rm]
```

Session records and device credentials are local private configuration. A
session selects a durable server context; deleting a local session file does
not rewrite semantic workspace history.

A linked-agent token authenticates only its exact live session entity. Its
context, channel, and owner are derived from the entity graph, not copied into
the token or credential database. Do not treat the token as evidence of agent
intent, human authorship, authorization, or content origin; discover those by
walking invocation and semantic provenance.

## Filesystem commands

Use `fs ls`, `read`, `write`, `rm`, `mkdir`, `stat`, `grep`, and `glob` for
ordinary navigation and content work. Managed writes compile to semantic edit
records and advance the context working head.

Use explicit identity operations for managed relocation and duplication:

```bash
vibestudio vcs move-file SOURCE DESTINATION [SOURCE DESTINATION ...]
vibestudio vcs copy-file SOURCE DESTINATION [SOURCE DESTINATION ...]
```

Move preserves a stable file ID. Copy mints a new file ID and records immediate
source-content provenance. Use the direct `vcs.move` or `vcs.copy` service
method for exact batches. Do not manipulate managed paths with a generic
filesystem transfer and expect history to be reconstructed afterward.

Scratch-only files remain ordinary context-local data. To bring an external
tree into managed semantic history, use `vcs.importSnapshot` with honest source
evidence.

These mutation workflows require an in-process agent tool invocation or a direct
authorized human/device caller. A linked Claude session's agent credential has neither:
its managed `fs`/`vcs` mutations and `eval` are refused, while native local writes only
dirty disposable projection bytes. Linked sessions should use read/status/history/
compare/blame for orientation and ask the workspace agent to perform implementation.

## Canonical semantic VCS

Fetch the live canonical skill before a VCS task:

```bash
vibestudio agent skills skills/vibestudio-vcs
vibestudio agent services vcs --json
vibestudio eval run -e 'return await help("vcs")'
```

The context exposes one committed event and one working head. Each managed
edit, move, copy, integrate, or revert advances that local head. Commit or
discard consumes the complete local chain.

Every mutation includes a command ID. Reuse it only for an identical request
whose response is uncertain. If `RevisionChanged` requires a newly observed
basis or changed request, use a new command ID.

Call a method through the generic CLI transport with one request object in the
argument array:

```bash
vibestudio agent call vcs.status '[{"contextId":"CONTEXT_ID"}]'
```

Use [API.md](API.md) only as an offline method list. Prefer the live schema for
exact argument and result structures.

## Generic RPC

```bash
vibestudio agent call SERVICE.METHOD 'ARGS_JSON' [--target ID]
```

`ARGS_JSON` is an array of positional arguments. `--target` relays to a runtime
entity and its method may be entity-local.

## Other agent commands

```bash
vibestudio agent services [NAME]
vibestudio agent skills [NAME_OR_REPO_PATH]
vibestudio agent logs UNIT [--since MS] [--level L] [--limit N]
vibestudio agent skill install [--dir DIR] | print
```

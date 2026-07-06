# Recipes

End-to-end workflows. All examples assume a paired CLI; in this repo prefix
commands with `pnpm cli`.

## First contact with a server

```bash
vibestudio remote pair "vibestudio://connect?url=https://host.ts.net&code=ABC123"
vibestudio remote status                      # verify credential + reachability
vibestudio agent attach                       # session "default"
vibestudio agent services | head              # what can I call?
vibestudio agent skills                       # what does this workspace document?
```

One-shot variant — when no credential is stored yet, attach can pair first
(if already paired this is a usage error; `vibestudio remote logout` to re-pair):

```bash
vibestudio agent attach work --url https://host.ts.net --code ABC123
```

## Explore, edit, commit, and push a repo (the build-gated loop)

The loop is **edit → commit → push**:

1. `fs write` (and the `fs.*` write methods) route through **`vcs.edit`** — and
   you can call `vcs.edit` directly. They record tracked **WORKING** changes on
   your context head and project them to disk, but they are **not** a commit (no
   log entry, no build, never in `vcs.log`).
2. **`vcs.commit(message)`** folds those working edits into a deliberate,
   messaged snapshot — this is what `vcs.log` shows.
3. **`vibestudio vcs push`** advances `main`, **fast-forward-only** and
   **build-gated**. A push that comes back `build-failed` did NOT advance
   `main` — the diagnostics it prints are your next task list.

```bash
vibestudio fs ls /                                        # context root: panels/, workers/, ...
vibestudio fs grep "registerPanel" panels/notes -C 2
vibestudio fs read panels/notes/src/index.tsx > /tmp/index.tsx
# ...edit locally...
vibestudio fs write panels/notes/src/index.tsx --from-file /tmp/index.tsx   # WORKING edit
vibestudio vcs status --repo panels/notes                # changed paths + uncommitted count
vibestudio agent call vcs.commit '[{"message":"Fix panel registration"}]'  # seal the edits
vibestudio vcs push   --repo panels/notes                # advance main (build-gated)
```

A successful push prints the per-repo report and exits `0`:

```
pushed panels/notes
  ok       pushed    panels/notes
```

A **build-failed** push prints diagnostics grouped by file as
`file:line:col  severity  [source] message` and exits non-zero:

```
build-failed — main did NOT advance. Fix the diagnostics and re-push:

panels/notes/src/index.tsx:42:7  error  [tsc] Type 'string' is not assignable to type 'number'.
    const count: number = label;
panels/notes/src/index.tsx:58:3  error  [esbuild] Could not resolve "./missing"

2 diagnostics across 1 file(s).
```

Work the loop — read the cited lines, fix, commit, re-push — until it returns
`pushed`:

```bash
vibestudio fs read panels/notes/src/index.tsx | sed -n '40,44p'   # inspect line 42
# ...fix the type at index.tsx:42 and the import at :58 (fs write = vcs.edit)...
vibestudio agent call vcs.commit '[{"message":"Fix types + import"}]'   # seal the fix
vibestudio vcs push --repo panels/notes                                # re-push
```

> Want to check a build **before** committing? `vcs.previewBuild` builds your
> working content without touching `main` or the published baseline:
> `vibestudio agent call vcs.previewBuild '[{"repoPaths":["panels/notes"]}]'`.

Drive the loop from a script with `--json` (the full `VcsPushResult`):

```bash
result=$(vibestudio vcs push --repo panels/notes --json) || {
  echo "$result" | jq -r '.reports[].builds[].diagnostics[]
    | "\(.file):\(.line):\(.column) \(.severity) \(.message)"'
  exit 1
}
```

## Create a brand-new project (first push)

A repo is born from its first commit + push — there is no init step. Create the
unit's files under `<section>/<name>/`, commit them, then push the path; a green
build writes the repo's `main` as its first commit.

```bash
# A new panel — write its files (or use the create-project skill), commit, push.
vibestudio fs write panels/mynote/index.tsx \
  --content 'export default function MyNote() { return <div>hi</div>; }'
vibestudio fs write panels/mynote/package.json --content '{
  "name": "@workspace-panels/mynote",
  "vibestudio": { "title": "My Note" },
  "dependencies": { "@workspace/runtime": "workspace:*", "@workspace/react": "workspace:*" }
}'
vibestudio agent call vcs.commit '[{"message":"Create mynote panel"}]'   # seal the new files
vibestudio vcs push --repo panels/mynote                                 # creates main from empty
vibestudio vcs log  --repo panels/mynote                                 # one entry: the first commit
```

A new **package** is the same shape:

```bash
vibestudio fs write packages/mylib/index.ts --content 'export const add = (a:number,b:number)=>a+b;'
vibestudio fs write packages/mylib/package.json --content '{ "name": "@workspace/mylib", "exports": { ".": "./index.ts" } }'
vibestudio agent call vcs.commit '[{"message":"Add mylib package"}]'
vibestudio vcs push --repo packages/mylib
```

> A typo'd or empty path fails with `unknown repo … has no main and no content`
> — the push found no existing `main` and no committed files on your head to
> seed one (did you `vcs.commit`?).

## Fork an existing repo, keeping history

```bash
vibestudio vcs fork-repo panels/chat panels/mychat   # FROM_REPO TO_REPO; inherits history
vibestudio vcs log --repo panels/mychat              # shows the inherited commits
# The package.json name leaf is already rewritten. Make the DEEPER renames yourself:
vibestudio fs grep -i "chat" panels/mychat           # find component/class/contract names to rename
# ...rename them with fs write (= vcs.edit), then commit and push the fork:
vibestudio agent call vcs.commit '[{"message":"Fork chat → mychat"}]'
vibestudio vcs push --repo panels/mychat
```

Fork when you want an existing unit's code **and** its lineage; use the
create-a-new-project flow above when you want a clean empty history.

## Atomic group push across repos

When a fix in one repo breaks a dependent (or a refactor spans several repos),
commit each, then push them together. Repeat `--repo` — the push is
**all-or-none**: every repo's `main` advances or none does.

```bash
# Editing a shared package broke a panel that depends on it — commit both, then
# push them atomically:
vibestudio agent call vcs.commit '[{"message":"Rename Button prop"}]'   # commits all edited repos
vibestudio vcs push --repo packages/ui --repo panels/notes
```

If any repo in the group fails the build gate (or diverges), no head advances;
the report tells you which repo and which lines. Fix and re-push the group.

## Reconcile a diverged push (vcs.merge)

`push` is **fast-forward-only**: if `main` moved past your context head's base
since you forked, the push refuses with `status:"diverged"` (it never
force-merges). Reconcile with an explicit `vcs.merge`, then re-push:

```bash
vibestudio vcs push --repo panels/notes --json | jq -r '.status'   # -> "diverged"

# Pull main into your context head as a merge commit. The result tells you
# whether it was clean or needs resolution.
vibestudio agent call vcs.merge '["panels/notes"]'
# -> { status, mergeable: "clean" | "conflict", upstreamCommits, conflictPaths? }
```

- **`mergeable:"clean"`** — no overlapping changes; the merge already committed.
  Just re-push: `vibestudio vcs push --repo panels/notes`.
- **`mergeable:"conflict"`** — conflict markers were written into your context
  filesystem at `conflictPaths`. Resolve each, then commit the resolution and
  re-push:

```bash
vibestudio agent call vcs.merge '["panels/notes"]' | jq -r '.conflictPaths[]'
vibestudio fs read panels/notes/src/index.tsx        # contains <<<<<<< / ======= / >>>>>>> markers
# ...edit out the markers (fs write = vcs.edit)...
vibestudio fs write panels/notes/src/index.tsx --from-file /tmp/resolved.tsx
vibestudio agent call vcs.commit '[{"message":"Merge main into notes"}]'   # seals the resolution
vibestudio vcs push --repo panels/notes                                    # now fast-forwards
```

To abandon uncommitted edits (and any pending merge) on a repo, drop them:

```bash
vibestudio agent call vcs.discardEdits '["panels/notes"]'
```

## Trace provenance: history, blame, and a commit's edits

Every working edit is recorded with provenance, and each commit owns the edits
it sealed — so you can trace any line back to its edit and its commit:

```bash
# File history / blame — every edit to a path (committed first, then the
# uncommitted working tail), newest commit lineage first.
vibestudio agent call vcs.fileHistory '["panels/notes","src/index.tsx"]'

# The exact edit-ops a commit folded in (commit event id from vcs.log).
vibestudio agent call vcs.commitEdits '["panels/notes",{"eventId":"evt-123"}]'

# Walk a commit's ancestry in the event-keyed commit DAG.
vibestudio agent call vcs.commitAncestors '["panels/notes","evt-123"]'
```

## Inspect a single repo's history

Every repo (`packages/foo`, `panels/chat`, `projects/vault`, `meta`) has its own
log — `vcs log --repo` shows only that repo's **commits** (working edits never
appear):

```bash
vibestudio vcs push-status --repo panels/notes    # how far ahead of main am I?
vibestudio vcs diff        --repo panels/notes     # name-status of unpushed changes
vibestudio vcs log         --repo panels/notes --limit 10
vibestudio vcs log         --repo meta             # config history (meta is a content repo)
```

## Check context drift and rebase

Your session context is a **pinned snapshot** — it doesn't drift as other contexts
push. To see what you've touched and whether `main` has moved past your pin, and to
catch up, use the `vcs.contextStatus` / `vcs.rebaseContext` RPCs:

```bash
# Per-repo {forked, ahead, behind} for your context.
vibestudio agent call vcs.contextStatus '[]'
# If repos show "behind": merge latest main into your edits + re-pin your base.
vibestudio agent call vcs.rebaseContext '[]'
```

`ahead` = push it; `behind` = rebase to pick up others' pushes (conflicts are
reported per repo). Useful when running **parallel sessions** that edit overlapping
repos.

## Analyze live data with a persistent REPL

```bash
vibestudio eval run -e '
  scope.entities = await services.runtime.listEntities({});
  return scope.entities.length;
'
# next run reuses scope.entities — no refetch
vibestudio eval run -e 'return scope.entities.filter(e => e.kind === "panel").map(e => e.id)'
vibestudio eval repl-reset      # when the cached state goes stale
```

## Pipe JSON through jq

Output is already JSON when piped:

```bash
vibestudio agent sessions | jq -r '.[].name'
vibestudio fs grep "TODO" --max 50 | jq '.matchCount'
vibestudio vcs status --repo panels/notes | jq '{uncommitted, added, changed, removed}'
vibestudio vcs push --repo panels/notes --json | jq -r '.status'
```

## Call a service the CLI has no command for

```bash
vibestudio agent services workspace --json | jq '.methods | keys'   # check the schema
vibestudio agent call workspace.listSkills '[]'
vibestudio agent call vcs.status "[\"panels/notes\",\"ctx:$(vibestudio agent status --json | jq -r .contextId)\"]"
```

## Create and call a worker

The workerd service is not shell-callable — create workers through
`runtime.createEntity` with `kind: "worker"` (spec:
`{kind, source, ref?, contextId?, key?, stateArgs?, env?}`; returns
`{id, kind, source, contextId, targetId}`):

Omitting `ref` launches the main build. `contextId` chooses the worker's runtime
state/files; it does not imply `ctx:<contextId>`. For code that exists only on a
context branch, launch with both `contextId` and `ref: "ctx:<contextId>"`.

```bash
vibestudio agent call runtime.createEntity '[{"kind":"worker","source":"workers/stats","key":"stats-1"}]'
vibestudio agent call ping --target "worker:workers/stats:stats-1"   # relayed: plain method name
vibestudio agent call runtime.retireEntity '[{"id":"worker:workers/stats:stats-1"}]'
```

The same works from eval:

```bash
vibestudio eval run -e '
  const h = await services.runtime.createEntity({ kind: "worker", source: "workers/stats", key: "stats-1" });
  return h.targetId;
'
```

For a context-local worker build in eval:

```bash
vibestudio eval run -e '
  const h = await services.runtime.createEntity({
    kind: "worker",
    source: "workers/stats",
    key: "stats-ctx",
    contextId: ctx.contextId,
    ref: `ctx:${ctx.contextId}`,
  });
  return h.targetId;
'
```

## Debug a misbehaving worker/unit

```bash
vibestudio agent call workspace.units.list '[]'
vibestudio agent logs my-worker --level warn --limit 100
vibestudio eval run -e 'return await help("workers")'
```

## Run a script file with npm dependencies

```bash
cat > /tmp/report.ts <<'EOF'
import _ from "lodash";
const files = await fs.glob("**/*.md");
return _.countBy(files, f => f.split("/")[0]);
EOF
vibestudio eval run /tmp/report.ts --imports '{"lodash":"npm:4"}'
```

## Parallel sessions for isolated work

Each session owns an isolated context folder, so two tasks cannot trample
each other:

```bash
vibestudio agent attach featureA
vibestudio agent attach bugfixB
vibestudio fs write notes.md --content "task A" --session featureA
vibestudio fs ls / --session bugfixB        # does not see featureA's files
vibestudio agent detach featureA --rm       # clean up: retire + delete context
```

## Invite another device

```bash
vibestudio remote invite --ttl-ms 600000    # prints a pairing code + vibestudio:// link
```

## Install this skill into a project

```bash
vibestudio agent skill install              # -> ./.claude/skills/vibestudio-agent
vibestudio agent skill install --dir ~/myproj/.claude/skills/vibestudio-agent
```

## Channels: read, post, follow

Channels are the workspace's conversations. The CLI resolves the channel DO and
relays to it — messages you `send` are durable and rendered like any other
participant's, but you do **not** join the roster (no presence).

```bash
# Channels bound to your current context (all workspaces with --all):
vibestudio channel list
# Durable history, paged (page with --after = the last seq you saw):
vibestudio channel history <channelId> --limit 50
vibestudio channel history <channelId> --after 120
# Post a message as yourself (a human shell device, or the agent under a token);
# address participants with --to (repeatable):
vibestudio channel send <channelId> --text "build is green" --to @alice
# Follow live over the WS push transport (Ctrl-C to stop):
vibestudio channel tail <channelId>
# Who's in the room:
vibestudio channel roster <channelId>
```

`channel tail` needs a push-capable connection: it works with an agent token
(launched/plugin session) and over a loopback/LAN or WebRTC device credential.
On a bare HTTP-only pairing, use `channel history` polling instead.

## Remote context mirror

Get a real local working tree for a context (e.g. on a second machine), then
drive it with the same `fs`/`vcs` commands — the marker makes scoping automatic.

```bash
# Materialize a context's repos into ./<contextId> and drop the scope marker:
vibestudio context mirror <contextId> ./work
cd ./work                      # fs/vcs/eval/channel now auto-scope here
# Keep it live: local edits become context edit ops; inbound changes re-apply:
vibestudio context mirror <contextId> ./work --watch
```

Conflicts surface through the context's normal edit/commit semantics — the
mirror adds no merge model (concurrent edits look like two panels editing one
context). Inbound sync is an interval poll of the context's repo states (v1).

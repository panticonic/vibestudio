# Vibestudio State Directory

## Location

Vibestudio uses platform-specific directories for storing application state, following OS conventions:

| Platform    | Location                                    |
| ----------- | ------------------------------------------- |
| **Linux**   | `~/.config/vibestudio/`                     |
| **macOS**   | `~/Library/Application Support/vibestudio/` |
| **Windows** | `%APPDATA%\vibestudio\`                     |

These paths are determined by `getUserDataPath()` from `@vibestudio/env-paths`.

## Contents

### `builds/`

Content-addressed build store. Each build is stored immutably at `{userData}/builds/{build_key}/`:

```
{build_key}/
  ├── bundle.js
  ├── bundle.css      (panels/about only)
  ├── index.html      (panels/about only)
  ├── package.json    (workers/extensions only — {"type":"module"})
  ├── assets/         (chunks, images, fonts)
  └── metadata.json   (sentinel — kind, name, ev, sourcemap, builtAt)
```

The build key is a hash of `BUILD_CACHE_VERSION + unitName + effectiveVersion + rootDepsFingerprint + sourcemap`. No LRU or TTL — garbage collection prunes entries not referenced by any active unit.

**When to clear**:

- If you suspect stale/corrupt builds
- To force rebuild all panels
- To reclaim disk space

### `blobs/`

Per-workspace content-addressable object store, written by the server's
`blobstoreService`. Layout:

```
blobs/
  tmp/                          # incoming partial writes (swept on startup)
  sha256/<aa>/<bb>/<rest>       # immutable objects, two-level fanout
```

Each object filename is the remaining 60 hex chars of its sha256 digest. The
two-level fanout keeps any single directory bounded. The algorithm name is
embedded in the path so additional digests can be added later without
migrating existing objects.

Writes go via `PUT /_r/s/blobstore/blob` (streaming, atomic-link to the final
path with EEXIST treated as a dedup hit); reads via `GET /_r/s/blobstore/blob/<digest>`.
There is no automatic GC — the layer above (e.g. the workspace's
git-replacement system) is responsible for tracking reachability and calling
`blobstore.delete(digest)`. See
[`docs/architecture/storage.md`](docs/architecture/storage.md#blobstore-content-addressable-objects).

### `external-deps/`

Stores external dependency installs (npm `node_modules`) for panels and workers, keyed by a hash of the merged dependency set. Extension runtime dependencies that may run lifecycle scripts are stored separately under `extension-runtime-deps/`.

### `extension-runtime-deps/`

Stores extension runtime dependency installs for packages esbuild leaves external, keyed by dependency hash plus platform, architecture, and Node ABI. Unlike `external-deps/`, this cache may run package lifecycle scripts because extension install/update approval grants native-code trust.

### `.contexts/`

Per-context filesystem scopes at `workspaces/{name}/state/.contexts/{contextId}/` (the server's state directory is already per-workspace, so there is no workspace level inside it). Each context gets an isolated filesystem root managed by `ContextFolderManager` and used by sessions, panels, workers, and DOs.

In the multi-user model each **panel slot** gets its own context (the context id is derived per slot, so two users opening the same panel source get independent contexts), and each runtime (worker/DO/agent) gets its own per-runtime scratch context. Shared workspace Durable Objects stay **shared** across the workspace's members — mutual inspectability is the product; there is no per-user DO partitioning.

At materialization, `WorkspaceVcs.ensureContextFolder` writes a host-owned bookkeeping marker `.vibestudio-context.json` at the context folder root — `{ contextId, workspaceId, serverUrl? }` (`serverUrl` is the loopback ws RPC base URL, present once the gateway port is finalized). It lets CLI + agent scope resolution (cwd-upward search) bind to the right server, workspace, and context with zero flags. It is **not** workspace source: `.vibestudio-context.json` is in `ALWAYS_IGNORED_FILES` (and the userland `VCS_IGNORED_FILES` twin), so the VCS scan never captures it, `vcs.edit` refuses to write it, and it never appears in projection/diff/status. The marker is rewritten idempotently only when its contents drift.

### `.databases/workerd-do/`

Workspace-local workerd Durable Object databases. Machine-control SQLite files
(`identity.db`, which includes the central catalog, and `push.db`) are documented
separately below:

```
.databases/
  workerd-do/
    vibestudio_internal:EvalDO/
      <object-hash>.sqlite
    vibestudio_internal:WebhookStoreDO/
      <object-hash>.sqlite
    vibestudio_internal:WorkspaceDO/
      <object-hash>.sqlite
    vibestudio_internal:BrowserDataDO/
      <object-hash>.sqlite
    <workspace-source>:<WorkspaceDOClass>/
      <object-hash>.sqlite
```

The internal stores are:

- `EvalDO` (per-owner object key) for eval REPL scopes.
- `WebhookStoreDO` (`objectKey: "global"`) for webhook ingress subscriptions.
- `WorkspaceDO` (`objectKey: <workspaceId>`) for entity/slot state and panel FTS (replaced `PanelStoreDO`/`ScopeStoreDO`).
- `BrowserDataDO` (`objectKey: "global"`) for imported browser data.

Outside `workerd-do/`, machine control state uses the SQLite files documented
below. There are no whole-file JSON registries.

### `server-auth/identity.db`

The hub-owned identity database — **one** `node:sqlite` file (WAL mode) that is
the single source of truth for all identity data: `users` (including role —
`root`/`admin`/`member` — and avatar data-URIs / profile fields), `devices`,
`agent_credentials`, `pairing_codes`, `membership` (user ⇄ workspace rows),
`workspaces`, per-user resume targets, and machine preferences. Workspace rows
carry opaque IDs (`ws_<rand>`) decoupled from names and paths. Host control
processes update individual rows under SQLite transactions; workspace children
open the identity projection
**read-only** (`PRAGMA query_only = ON`, participating in WAL like any reader)
via the `VIBESTUDIO_IDENTITY_DB_PATH` env the hub passes them, so membership
checks, subject resolution, and profile reads in a child always see the live
data with no push protocol. `server-id.json` (the stable server identity)
lives alongside it in `server-auth/`.

There are **no JSON identity stores**: no `users.json`, no `memberships.json`,
and no per-child `auth/devices.json` — those were deleted in the multi-user
cutover, and the store classes (`UserStore`, `DeviceAuthStore`,
`MembershipStore`) are thin typed wrappers over the DB tables.

### `server-auth/push.db`

Per-user push registrations, keyed by `(user_id, client_id)` with a unique FCM
token. Row-level SQLite updates let workspace processes register devices without
whole-file lost-update races, and caller-derived ownership prevents one account
from overwriting or unregistering another account's client ID.

### `governance/governance.db`

The host-owned governance log (`packages/shared/src/governance/governanceLog.ts`):
a transactional SQLite ledger with an exact schema. It records both
approval provenance (who resolved which credential/capability/userland approval,
from which surface) and membership governance (invite/revoke user, add/remove
member, role changes) as one time-ordered timeline, queryable through the
`governance` service. The host process is the sole writer; userland may read a
projection but never writes. SQLite transactions protect crash consistency and
the unique approval id rejects conflicting replays across lost responses. There
is deliberately no hash chaining — the audience is a mutually-trusting team, so
the log is attribution, not tamper-evidence.

### `ev-state.json`

Persisted effective-version state — derived data that is safe to delete to
trigger a full recompute on the next startup.

### `device-credentials.json`

Encrypted (Electron `safeStorage`) paired-device credentials for the single
detached loopback hub and one selected WebRTC remote
(`src/main/services/deviceCredentialStore.ts`). Entries are keyed by `serverId`
and include `{ transport, deviceId, refreshToken, pairedAt }`. The loopback
credential is machine-global and never workspace-bound. The schema-v3 WebRTC
entry carries distinct `controlPairing` and `workspacePairing` coordinates,
each with exact `room`/`fp`/`sig`/`v`/`ice` and optional `srv`, minus the
one-time code. The stable control reach lists/routes workspaces; the selected
workspace reach serves workspace RPC. On later launches the shell reattaches
with `refresh:<deviceId>:<refreshToken>` instead of re-pairing.

The file lives at the central path above, never inside a workspace's `state/`
directory. On first access, current-schema files left in the retired
workspace-local or `bootstrap-state/` locations are merged into this central
store by newest credential timestamp; the encrypted legacy files are left in
place until the operator removes the old workspace.

The validator rejects unknown fields, more than one remote entry, persisted
one-time codes, and any retired credential shape. Previous stores are neither
read nor migrated.

### `workspaces/{name}/state/webrtc/identity.pem`

Combined WebRTC DTLS certificate and private key used by one workspace child answerer.
The certificate SHA-256 fingerprint is embedded as `fp` in pairing links. This
combined file is the only recognized identity layout. Operators deliberately
replace it with `vibestudio remote repair-identity --workspace <name> --yes`.

### `server-auth/hub-ready.json`

Ready file written by the one detached local hub once its gateway is listening
(`src/server/hubServer.ts`). Payload includes `mode`, `gatewayPort`, the first-run
`rootInvites` (complete desktop/mobile invites, or `null` after bootstrap),
`serverId`, `serverBootId`, `pid`, and `version`. The desktop accepts only a
fresh hub-mode record, pairs its global device once, and asks the hub to route
the selected workspace child.

### `logs/hub.log`

Combined stdout/stderr of the detached hub (`stdio` target of the spawn),
truncated on each spawn. Child logs remain in each workspace state directory.

### `workspaces/{name}/state/logs/server-log.jsonl`

Structured host-log records (`{seq, timestamp, level, tag, message, fields, pid}`)
appended by the server's own log capture (`src/server/services/serverLogStore.ts`),
one JSON object per line. Rotated to `.1` on each boot and at ~16 MB. The same
records are queryable/streamable live through the `serverLog` RPC service (see
`workspace/skills/server-logs/SKILL.md`); this file is the post-mortem copy for a
server that already exited. Secrets (pairing codes, tokens) are redacted.

## Fallback Behavior

If the platform-specific directory cannot be accessed (e.g., permissions issues), Vibestudio falls back to:

```
<os-config-dir>/vibestudio/  (or ultimately a temp directory)
```

This ensures the app continues to work even in restricted environments.

## Implementation

See [`src/main/paths.ts`](src/main/paths.ts) and
[`docs/architecture/storage.md`](docs/architecture/storage.md) for the
implementation details.

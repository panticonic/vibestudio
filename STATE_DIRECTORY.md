# Vibestudio State Directory

## Location

Vibestudio uses platform-specific directories for storing application state, following OS conventions:

| Platform | Location |
|----------|----------|
| **Linux** | `~/.config/vibestudio/` |
| **macOS** | `~/Library/Application Support/vibestudio/` |
| **Windows** | `%APPDATA%\vibestudio\` |

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

The build key is a hash of `BUILD_CACHE_VERSION + unitName + effectiveVersion + sourcemap`. No LRU or TTL — garbage collection prunes entries not referenced by any active unit.

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

### `build-artifacts/`

Stores external dependency installs (npm `node_modules`) for panels and workers, keyed by a hash of the merged dependency set. Extension runtime dependencies that may run lifecycle scripts are stored separately under `extension-runtime-deps/`.

### `extension-runtime-deps/`

Stores extension runtime dependency installs for packages esbuild leaves external, keyed by dependency hash plus platform, architecture, and Node ABI. Unlike `external-deps/`, this cache may run package lifecycle scripts because extension install/update approval grants native-code trust.

### `.contexts/`

Per-context filesystem scopes at `workspaces/{name}/state/.contexts/{contextId}/` (the server's state directory is already per-workspace, so there is no workspace level inside it). Each context gets an isolated filesystem root managed by `ContextFolderManager` and used by sessions, panels, workers, and DOs.

At materialization, `WorkspaceVcs.ensureContextFolder` writes a host-owned bookkeeping marker `.vibestudio-context.json` at the context folder root — `{ contextId, workspaceId, serverUrl? }` (`serverUrl` is the loopback ws RPC base URL, present once the gateway port is finalized). It lets CLI + agent scope resolution (cwd-upward search) bind to the right server, workspace, and context with zero flags. It is **not** workspace source: `.vibestudio-context.json` is in `ALWAYS_IGNORED_FILES` (and the userland `VCS_IGNORED_FILES` twin), so the VCS scan never captures it, `vcs.edit` refuses to write it, and it never appears in projection/diff/status. The marker is rewritten idempotently only when its contents drift.

### `.databases/workerd-do/`

The only SQLite files Vibestudio owns are workerd Durable Object databases:

```
.databases/
  workerd-do/
    vibestudio_internal:ScopeStoreDO/
      <object-hash>.sqlite
    vibestudio_internal:WebhookStoreDO/
      <object-hash>.sqlite
    vibestudio_internal:PanelStoreDO/
      <object-hash>.sqlite
    vibestudio_internal:BrowserDataDO/
      <object-hash>.sqlite
    <workspace-source>:<WorkspaceDOClass>/
      <object-hash>.sqlite
```

The internal stores are:

- `ScopeStoreDO` (`objectKey: "global"`) for REPL scope snapshots.
- `WebhookStoreDO` (`objectKey: "global"`) for webhook ingress subscriptions.
- `PanelStoreDO` (`objectKey: <workspaceId>`) for panel tree and panel FTS.
- `BrowserDataDO` (`objectKey: "global"`) for imported browser data.

Legacy host-owned SQLite files are removed on server startup. There are no
other Vibestudio-managed SQLite files outside `workerd-do/`.

### `ev-map.json`

Persisted effective version map — derived state, safe to delete (triggers full recompute on next startup).

### `ref-state.json`

Per-unit commit SHAs used for cold-start diffing. Compared against current refs to determine which units need EV recomputation.

### `data.json`

Central desktop bookkeeping (`CentralDataManager`, `packages/shared/src/centralData.ts`).
Besides the workspace list, each `WorkspaceEntry` may carry a `localServer`
attachment record — `{ gatewayPort, pid, serverId, serverBootId, startedAt,
version }` — describing the detached local workspace server the desktop last
attached to. It is validated against `GET /healthz` (matching `serverId` +
`workspaceId`) before reuse and pruned with the workspace entry. A top-level
`keepServerOnQuit` boolean records the remembered "keep the server running on quit"
choice. Both the desktop and the server may write this file; whole-file
last-writer-wins is intentional for a single-user product.

### `device-credentials.json`

Encrypted (Electron `safeStorage`) paired-device credentials for both detached
loopback workspace servers and WebRTC remote servers
(`src/main/services/deviceCredentialStore.ts`). Entries are keyed by `serverId`
and include `{ transport, deviceId, refreshToken, pairedAt }`; loopback entries
also carry `workspaceId`, while WebRTC entries carry the pinned pairing material
(`room`/`fp`/`sig`/`ice`/`srv`) minus the one-time code. On later launches the
shell reattaches with `refresh:<deviceId>:<refreshToken>` instead of re-pairing.

The previous split paired-device stores are not read or migrated.

### `webrtc/identity.pem`

Combined WebRTC DTLS certificate and private key used by the server answerer.
The certificate SHA-256 fingerprint is embedded as `fp` in pairing links. Old
`server.pem` / `server.key` remnants make startup fail so operators repair the
identity explicitly with `vibestudio remote repair-identity --yes`.

### `workspaces/{name}/state/server-ready.json`

Ready file written by a freshly spawned detached workspace server once its gateway is
listening (`src/server/index.ts`). Payload includes `gatewayPort`, the startup
`pairingCode`, `serverId`, `serverBootId`, `pid`, and `version`. The desktop spawner
polls for a write newer than spawn time, then pairs over the loopback WebSocket using
the `pairingCode`.

### `workspaces/{name}/state/logs/server.log`

Combined stdout/stderr of the detached workspace server (`stdio` target of the
spawn), truncated on each spawn. Server output no longer flows through the app, so
this is the place to look for local server diagnostics.

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

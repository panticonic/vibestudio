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

### `build-cache/`

Complete immutable build results shared by managed workspaces and addressed by
the normal Build V2 key. Artifact files are hardlinks into `cas/`; the small
manifest and metadata files make a cached result immediately activatable in a
new workspace without rebuilding it.

### `cas/`

Global physical SHA-256 content store shared by all managed workspaces. Workspace
blob namespaces and build artifact files hardlink into this store, so identical
bytes occupy one inode even when several workspaces reference them. The CAS is
not itself an authorization namespace: services continue to check the
workspace-local reference before serving a digest.

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

Build metadata and manifests remain per-workspace, while immutable artifact
payloads are hardlinks into the global `cas/`. This preserves workspace-specific
provenance (`sourceStateHash`, `builtAt`) without duplicating bundle bytes.

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
two-level fanout keeps any single directory bounded. These paths are logical
workspace-membership references hardlinked into the global `cas/`; a workspace
cannot read another workspace's blob merely by knowing its digest.

Writes go via `PUT /_r/s/blobstore/blob` (streaming, atomic-link into the global
CAS and then into the workspace namespace, with EEXIST treated as a dedup hit);
reads via `GET /_r/s/blobstore/blob/<digest>`. Deletion removes the workspace
reference, never another workspace's reference. The layer above (e.g. the
workspace's git-replacement system) remains responsible for tracking workspace
reachability and calling `blobstore.delete(digest)`. See
[`docs/architecture/storage.md`](docs/architecture/storage.md#blobstore-content-addressable-objects).

### `external-deps/`

Stores external dependency installs (npm `node_modules`) for panels and workers, keyed by a hash of the merged dependency set. Extension runtime dependencies that may run lifecycle scripts are stored separately under `extension-runtime-deps/`.

### `extension-runtime-deps/`

Stores extension runtime dependency installs for packages esbuild leaves external, keyed by dependency hash plus platform, architecture, and Node ABI. Unlike `external-deps/`, this cache may run package lifecycle scripts because extension install/update approval grants native-code trust.

### `workspaces/{name}/state/git-checkouts/`

Operational Git interchange checkouts live at
`workspaces/{name}/state/git-checkouts/<repoPath>/`. The manifest-selected
`gitInterop` provider owns these directories for fetch, exact HEAD-tree import,
protected-main export, commit trailers, and Git transport. They are host state,
not workspace source, semantic context projections, or durable provenance.

The semantic boundary is explicit in both directions. Import reads an exact
immutable Git tree and admits it through `vcs.importSnapshot` as a committed
candidate; export reads an exact protected semantic event through VCS/CAS and
projects it into Git. Deleting an operational checkout removes transport state,
not semantic workspace content. Startup asks provider `upstreamStatus` whether
each declared checkout is materialized; it does not infer that fact by looking
for a source directory.

Build V2 never reads these checkouts. It resolves exact semantic repository
states through the content store and materializes only a disposable build-source
closure under its own cache namespace.

### `.context-projections/v5/`

Disposable filesystem projections of semantic contexts live at
`workspaces/{name}/state/.context-projections/v5/{contextId}/`. The server's
state directory is already per-workspace, so there is no additional workspace
level inside this namespace. `v5` is the only projection epoch understood by
the current process: the loader derives it from the canonical workspace
topology, and `ContextFolderManager` receives that exact root rather than
discovering a directory or selecting among versions.

These directories are caches of VCS-authoritative context state, not independent
filesystem scopes or durable sources of truth. Sessions, panels, workers, and
DOs may use a projection after the VCS host has materialized it. A missing
projection is rebuilt from semantic state. A malformed current-epoch projection
is an error; the server does not reinterpret it through an older schema or
migrate it in place. Pre-epoch debris is ignored by loading and denied to source
scans and copy/build tooling.

In the multi-user model each **panel slot** gets its own context (the context id is derived per slot, so two users opening the same panel source get independent contexts), and each runtime (worker/DO/agent) gets its own per-runtime scratch context. Shared workspace Durable Objects stay **shared** across the workspace's members — mutual inspectability is the product; there is no per-user DO partitioning.

At materialization, `WorkspaceVcs.ensureContextFolder` writes the strict public
binding `.vibestudio-context.json` at the projection root. Its exact
`vibestudio.context-binding.v1` shape contains only the durable `workspaceId` and
`contextId`. CLI and agent scope resolution find it by walking upward from cwd,
verify its workspace against the paired credential, and use that credential's
current hub/WebRTC route for reach. The binding never stores an endpoint,
credential, projection generation, semantic receipt, or agent attribution.

The host's disposable materialization receipt lives separately at
`.gad/context-materialization.json`. It records the last semantic basis and
repository targets needed for crash recovery and mirror reads, but is not a public
protocol or durable semantic source. Both files are **not** workspace source:
`.vibestudio-context.json` is in `ALWAYS_IGNORED_FILES` (and the userland
`VCS_IGNORED_FILES` twin), `.gad/` is always ignored, `vcs.edit` refuses to write
either, and neither appears in projection, diff, or status.

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
each with exact `room`/`fp`/`sig`/`v`/`ice`, minus the
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

### `workspaces/{name}/reach/webrtc/`

Hub-owned reachability state for the advertised workspace, deliberately outside
its semantic `state/` tree:

- `identity.pem` is the combined WebRTC DTLS certificate and private key. Its
  SHA-256 fingerprint is embedded as `fp` in pairing links.
- `routes.json` maps authenticated devices, users, and outstanding invites to
  their durable signaling rooms.
- `pairing-activations.json` holds bounded, expiring activation receipts while
  a one-time invite is promoted into a durable device route.

Deleting or reseeding semantic state must not rotate either file: a paired
device's transport contract is independent of semantic history. Deleting the
workspace removes the whole workspace envelope, including reachability.
`vibestudio remote repair-identity --workspace <name> --yes` deliberately
rotates the identity and therefore requires devices to re-pair. No retired
`state/webrtc/` layout is read or migrated.

### `server-auth/hub-ready.json`

Ready file written by the one detached local hub once its gateway is listening
(`src/server/hubServer.ts`). Payload includes `mode`, `gatewayPort`, the first-run
`rootInvite` (one complete pairing invite, or `null` after bootstrap),
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

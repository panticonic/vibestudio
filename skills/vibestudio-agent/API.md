<!-- GENERATED FILE — do not edit. Regenerate with: pnpm generate:agent-docs -->

# Vibestudio RPC Service Reference (agent CLI)

Every service below is callable from a paired CLI as
`vibestudio agent call SERVICE.METHOD 'ARGS_JSON'` (and from `vibestudio eval run`
code as `services.SERVICE.METHOD(...args)` or `rpc.call("SERVICE.METHOD", args)`).

This file lists methods and descriptions only. For full Zod argument and
return schemas of a service, ask the live server:

```bash
vibestudio agent services SERVICE_NAME --json
```

Generated statically from `src/server/services/`; a server build may register
a subset depending on its configuration — `vibestudio agent services` shows what
is actually live. This is the selected workspace child's API. Server-wide
workspace, device, and account mutation commands run over the client's separate
stable hub session and intentionally do not appear as child services here.

Some internal services (e.g. workerd) do not admit paired user authority and do not appear
here. Create workers and DOs via `runtime.createEntity` (`kind: "worker"` /
`"do"`), then dispatch to them with `--target` relay calls.

## `account`

Read-only live account profiles for this workspace

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `account.getProfile` | Resolve one account's live profile (defaults to the caller's own subject). Returns null for an unknown userId. |
| `account.resolveProfiles` | Batch-resolve userIds to live profiles for rendering user participants. Unknown ids are absent from the result. |
| `account.isMember` | Return whether a user belongs to this child server's bound workspace. The workspace is host-bound, never caller-selected. |
| `account.listWorkspaceMembers` | List live account profiles for this child server's bound workspace, including implicit root membership. |

## `audit`

Audit log query access

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `audit.query` |  |

## `auth`

Gateway authentication bootstrap routes

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `auth.grantConnection` | Mint a short-lived connection token for a panel/app caller (requires the panel-hosting capability), granting it access to the gateway. |
| `auth.getConnectionInfo` | Report how clients should reach this gateway: server/connect URLs, protocol, server identity, and current workspace. |

## `authority`

Acquisition lifecycle and side-effect-free authority inspection

Authority principals: `code`, `host`, `mission`, `session`, `user`

| Method | Description |
|--------|-------------|
| `authority.awaitDecision` | Wait without a deadline for one acquisition owned by this session. |
| `authority.preflight` | Dry-run a service method's complete authority contract without prompting or consuming authority. |

## `baseRelease`

Verified host-to-Base release update handshake

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `baseRelease.check` | Compare the installed Base lineage with the host's verified immutable Base release pin. |
| `baseRelease.pull` | Ask Composer to pull the host's verified exact Base release through its server-only release handshake. |

## `blobstore`

Per-workspace content-addressable blob storage

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `blobstore.has` | Whether a blob with this content digest exists in the workspace store. |
| `blobstore.stat` | Size (bytes) and last-modified time of a blob, or null if it does not exist. |
| `blobstore.putText` | Store a UTF-8 string; returns its content digest + byte size. Content-addressed, so identical text always yields the same digest (idempotent). |
| `blobstore.getText` | Full UTF-8 text of a blob, or null if absent. |
| `blobstore.getRange` | UTF-8 text slice. offset/length are BYTES (so they compose with stat.size); the returned string is UTF-8-decoded, so partial codepoints at slice boundaries become U+FFFD replacement chars. Use getRangeBytes for a raw binary slice. |
| `blobstore.getRangeBytes` | Raw byte slice, base64-encoded on the wire so binary blobs (PDFs, images) round-trip intact. Decode with Buffer.from(result.bytesBase64, 'base64'). |
| `blobstore.grep` | Search a blob's text for a regex pattern; returns matching lines with optional surrounding context, or null if the blob is absent. |
| `blobstore.putBase64` | Store raw bytes from exactly one base64 string; returns content digest + byte size (idempotent by content). The blobstore stores bytes only: do not pass MIME/options metadata, and instead carry it alongside the returned digest. |
| `blobstore.getBase64` | Full blob contents as a base64 string, or null if absent. |
| `blobstore.putTree` | Store one immutable directory node in the content-addressed store and return its tree hash. Every referenced file blob and child tree must already exist, so a tree hash cannot name missing objects. Pass {root:true} to also store a content-state root pointer. Content states are build/projection inputs, never semantic revision or ancestry identities. Idempotent by content; build deep trees bottom-up. |
| `blobstore.getTree` | Entries of a tree object (one directory node), or null if absent. Accepts a `manifest:` node hash or a `state:` root pointer (resolved to its root node). |
| `blobstore.listTree` | Exact keyset-paged recursive listing of an immutable tree. Each page is bound to the requested ref, resolved root manifest, normalized prefix, and canonical tree-preorder. A continuation names the last emitted path; cursor/basis mismatches and missing interior objects fail loudly. Returns null only when the requested root object is absent. |
| `blobstore.readFileAtTree` | Resolve a tree-relative file path to its content digest and mode, or null if the path is absent or not a file. Read the bytes via the ordinary blob APIs. |
| `blobstore.diffTrees` | Bounded authoritative diff for host admission checks: added/removed/changed file paths, computed by Merkle walk (identical subtree hashes are skipped wholesale). Throws if either tree's objects are missing or the change set exceeds 100000 entries; semantic/user-facing comparison uses its exact paged projection. |
| `blobstore.materializeTree` | Project a tree onto disk at outDir (absolute path): hardlinks non-executable files from the CAS (copies executables so chmod never touches the shared CAS inode). Existing files with matching size are trusted and skipped. Admin-only — writes outside the store. |
| `blobstore.delete` | Delete a blob by digest; returns true if it existed. Destructive, admin-only. |
| `blobstore.list` | List blob digests, optionally filtered by hex prefix and capped by limit. Admin-only. |

## `browserPermissions`

Owner-scoped browser website permission grants

Authority principals: `user`

| Method | Description |
|--------|-------------|
| `browserPermissions.snapshot` | Read the current origin-scoped website permission projection. |
| `browserPermissions.request` | Request owner approval for origin-scoped website capabilities. |
| `browserPermissions.revoke` | Revoke remembered website permission grants for an origin. |

## `build`

Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `build.listUnits` | List declared executable source units and their build readiness. This is not a process list: use runtime.supervision.list for exact live entities. |
| `build.getBuild` | Build a panel/worker/extension unit (or a library bundle) and return its artifacts. The optional ref selects the workspace state to build from: omitted = main HEAD, a head name (e.g. 'ctx:abc'), or an immutable 'state:…' hash. Results are cached by content-derived build key, so rebuilding an unchanged unit reuses the cache. |
| `build.getBuildNpm` | Build an npm package as a CJS library bundle for sandbox use, leaving the given externals unbundled. |
| `build.getBuildMetadata` | Cached build metadata for an immutable build key, or null if it is not cached. Includes the unit's most recent structured build diagnostics (esbuild + tsc) when any were captured. Pass includeExecutableModules:false for compact profiling and provenance reads that do not need the sealed source inventory. |
| `build.getBuildReport` | Explicitly build a unit (runtime, or library targets for packages) at the requested workspace state and return a compact, agent-actionable report. Read all diagnostics from report.diagnostics or target-specific diagnostics from report.builds. Artifact manifests are intentionally excluded; inspect an immutable build key separately when artifact provenance is needed. This advisory projection does not publish source, authorize publication, or advance any head. |
| `build.getPerformanceProfile` | Profile the canonical exact-context build report, summarize immutable artifact/module sizes without returning bundle contents, and optionally run the same report again to verify the cache path. The first run is labeled from immutable builtAt evidence rather than assumed cold. |
| `build.getEffectiveVersion` | Effective version (content-derived identity) of a workspace unit, or null if unknown. |
| `build.inspectBuildProvenance` | Resolve a workspace build unit (by name, relative path, or basename) and report its effective version, immutable build keys, and cached artifact metadata. Reports ambiguity when a basename matches multiple units. |
| `build.listRecentBuildEvents` | List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path. |
| `build.recompute` | Rediscover the package graph, recompute every unit's effective version, rebuild any changed buildable units, and return the set of changed/added/removed units. |
| `build.gc` | Inspect authoritative execution retention using host-owned roots without mutating artifacts or source content. Destructive collection is private to the coordinated host epoch. |
| `build.inspectExecution` | Explain one immutable execution identity, its authoritative owners, and whether its artifact and source closure remain reconstructible. |
| `build.getAboutPages` | List available about pages for the launcher UI. |
| `build.hasUnit` | Whether a build unit with this name exists in the workspace graph. |
| `build.getPanelMetadata` | Launcher metadata for a panel unit resolved from the caller-selected exact workspace ref, or null if absent or not a panel. |
| `build.listSkills` | List available workspace skill packages that can be loaded via the eval imports parameter. |

## `chromiumFetch`

Managed Chromium transport for web content retrieval

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `chromiumFetch.openPublic` | Open a cookie-free URL through the managed Chromium host. |
| `chromiumFetch.openBrowser` | Open a URL through Chromium with the user's canonical browser cookies. |
| `chromiumFetch.read` | Read an owner-bound chunk from an open Chromium response. |
| `chromiumFetch.close` | Close an owner-bound Chromium response. |

## `contentTrust`

Human-owned exact content vouches and bounded trust policies

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `contentTrust.status` | Report whether the context-integrity cutover is active. |
| `contentTrust.list` | List exact content vouches and future-content trust policies. |
| `contentTrust.vouch` | Trust one exact content-addressed lineage key. |
| `contentTrust.addPolicy` | Trust future versions from one exact package name or repository remote. |
| `contentTrust.revoke` | Revoke an exact content vouch or trust policy for future resolutions. |

## `credentials`

URL-bound userland credential storage and egress

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `credentials.connect` | Run a connection flow (OAuth2/OAuth1a/API-key/SSH/browser-session) to obtain and store a credential; interactive flows open a browser sign-in. |
| `credentials.configureClient` | Store (versioned) OAuth client configuration — authorize/token URLs and client fields such as client id/secret; userland callers are prompted to submit the material, and secrets are never returned in the status. |
| `credentials.requestCredentialInput` | Prompt the user to enter exactly one secret field, then store the resulting credential; the submitted secret is never returned in the summary. |
| `credentials.getClientConfigStatus` | Return the configured status of an OAuth client config (which fields are set, URLs, status) without revealing secret values; rejects callers outside the config's trust scope. |
| `credentials.deleteClientConfig` | Disable a client config (marks it deleted so it is no longer used for new connections or refreshes); requires critical account-provider deletion authority bound to the exact config id. |
| `credentials.forwardOAuthCallback` | Deliver an inbound OAuth provider callback (code/state, or a full callback URL) to its pending connection transaction, validating the caller against the transaction's redirect strategy. |
| `credentials.cancelOAuth` | Cancel a pending interactive OAuth connection transaction. |
| `credentials.listStoredCredentials` | List summaries of stored URL-bound credentials visible to the caller; secret material is never included. |
| `credentials.summarizeStoredCredentials` | Return only the aggregate count and represented lifecycle states for stored credentials; no per-credential fields are included. |
| `credentials.inspectStoredCredentials` | List administrator-facing credential summaries with runtime usage metadata; secret material is never included. |
| `credentials.revokeCredential` | Revoke a stored credential by id (marks it revoked and best-effort revokes the upstream provider token); requires critical account-disconnection authority bound to the exact credential id. |
| `credentials.resolveCredential` | Locate a stored credential by url/provider/id and authorize its use for the caller, returning a summary or null when nothing matches. |
| `credentials.completeCapture` | Complete a pending server-initiated session credential capture (`credential:capture-request` event) with the captured material or an error; callable only by the attached desktop shell. |
| `credentials.audit` | Query the credential egress audit log (optionally filtered by provider/connection/caller/since, paged by limit/after). |

## `developmentClientExecutor`

Owner-bound desktop executors for exact development-client launches

Authority principals: `user`

| Method | Description |
|--------|-------------|
| `developmentClientExecutor.register` | Register or refresh this authenticated desktop as a reviewed Electron development executor. |
| `developmentClientExecutor.claim` | Claim an exact pending development-client launch addressed to this desktop. |
| `developmentClientExecutor.readArtifact` | Read one bounded chunk of an exact pending artifact into the selected executor's owned root. |
| `developmentClientExecutor.launched` | Record the selected trusted executor's owned-process launch receipt. |
| `developmentClientExecutor.attest` | Attest readiness from the newly paired child session; identity and user are derived from the verified caller. |
| `developmentClientExecutor.bindIsolatedManager` | Bind the exact isolated generation's already-paired management device before any client invite is issued. |
| `developmentClientExecutor.consumeAttestation` | Consume one nonce-bound paired-child attestation through the exact isolated management device. |
| `developmentClientExecutor.fail` | Report a bounded launch failure from the exact selected desktop executor. |
| `developmentClientExecutor.exited` | Report exact owned-process exit and cleanup; the host derives whether it was an intentional stop. |

## `docs`

Agent-facing capability catalog: discover services and runtime APIs with typed schemas, access rules, and examples (results filtered to what the caller may invoke).

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `docs.search` | Search the capability catalog (services and runtime APIs) by keyword. Results are filtered to what the calling kind may invoke. Use docs.describe(id) for the full typed schema, access rules, and examples. |
| `docs.describe` | Return the full catalog entry for an id (typed args/returns schema, access/restrictedness, examples). Returns null if unknown or not visible to the caller. |
| `docs.getSchema` | Return just the args/returns JSON Schema for a catalog id. |
| `docs.listSurfaces` | List catalog surfaces and the number of entries the caller can see in each. |
| `docs.listServices` | List registered RPC services and their methods (per-service view with JSON-Schema args/returns), filtered to what the calling kind may invoke. Every service.method listed is callable as services.<service>.<method>(...). |
| `docs.describeService` | Describe one registered RPC service by name: its policy and every method the caller may invoke (with JSON-Schema args/returns). Returns null for an unknown service. |

## `durableWork`

Payload-free host durable-work dispatcher diagnostics

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `durableWork.inspect` | Return bounded, payload-free diagnostics for the host durable-work dispatcher, including hint/recovery attribution and recent phase timings. |

## `eval`

Owner-scoped sandbox eval backed by a per-owner internal EvalDO

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `eval.start` | Durably accept one caller-owned eval run. A new run executes asynchronously in the owner's EvalDO; replaying the same runId and exact input observes the same run, while input drift is rejected. A trivially fast or replayed settled run may return its terminal snapshot immediately. |
| `eval.get` | Read the canonical durable snapshot for a caller-owned eval run. This is a recovery/backstop read; agent-owned runs normally settle through the EvalDO's terminal completion push. |
| `eval.events` | Read one stable, bounded page of durable events for a caller-owned eval run. Subscribe to the canonical eval:run-event through events.watch for live delivery, then use this cursor page to catch up after reconnect or backpressure. |
| `eval.reset` | Reset the eval context: wipe the live/durable scope and user `db` tables while preserving kernel infrastructure. The owner's existing eval data is cleared. |
| `eval.dispose` | Permanently release one owner-scoped eval kernel and erase its scope, run records, loaded modules, runtime image, and entity registration. Use this for explicitly finite eval scopes; ordinary notebooks remain durable until disposed. |
| `eval.readScopeTextPage` | Read a bounded page from a string in the caller's current durable eval scope. Use this to retrieve a large eval result losslessly after an eval caches it under a scope key; pages are UTF-16LE base64 so every JavaScript string code unit round-trips exactly. |
| `eval.deleteScopeValue` | Delete one value from the caller's current durable eval scope and persist the deletion. Intended for cleaning up temporary keys used by lossless large-result paging. |
| `eval.cancel` | Cancel an in-flight or pending run by runId. The durable status is cancelling while registered cleanup runs and becomes cancelled only after cleanup settles, so the eval history and its owned cleanup remain one trust unit with valid teardown authority. Owned cleanup is awaited to real settlement and preserves other runs and scope. An unowned, non-cooperative guest run may trigger bounded recovery, which cancels all non-terminal runs, resets shared scope/user db, and returns forcedReset:true. A terminal run is a no-op with forcedReset:false. |

## `events`

Event subscriptions

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `events.watch` | Open a response stream for named events. The response body owns the subscription and cancelling it is the only unsubscribe operation. |

## `externalOpen`

Approval-gated system browser opens

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `externalOpen.openExternal` | Open an http(s) URL in the host browser or an OS-protocol URL in its registered application; approval-gated for code callers, returning the persisted approval decision when one was made. |

## `fs`

Filesystem operations. Context-bound callers are sandboxed to their context folder; the semantic workspace records managed reads and mutations before host projection, with structured move/copy preserving explicit provenance. Scratch-only adapters may access context-local paths outside reserved workspace source roots and fail closed for managed paths. An unchained extension granted the explicit host-fs-access capability is unrestricted and uses host filesystem paths.

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `fs.readFile` | Read a file's contents. Managed workspace files are resolved through the semantic authority at the context's exact working head, so projected disk bytes are never treated as authoritative; scratch paths read directly from the context filesystem. Overloaded: with an encoding string (or Node-style `{ encoding: "utf8" }`) the bytes are decoded and returned as a string; without one, raw bytes are returned base64-encoded in a binary envelope. (Server/shell callers prepend a contextId as the first argument.) |
| `fs.readText` | Read a bounded line range from a UTF-8 text file without transferring the complete file. Returns exact UTF-16 coordinates, total line count, continuation metadata, and a SHA-256 hash of the complete bytes. Managed files resolve through exact semantic authority; scratch files are streamed from disk. |
| `fs.readBytes` | Read a bounded byte range without decoding or transferring the complete file. Returns canonical base64, exact byte coordinates, total size, continuation metadata, and a SHA-256 hash of the complete bytes. Managed files resolve through exact semantic authority; scratch files are streamed from disk. |
| `fs.writeFile` | Write data to a file, replacing existing contents and creating missing parent directories. Paths are relative to a context-bound caller's root even when they start with '/'. Managed workspace files are recorded as semantic VCS operations before the accepted working head is projected; platform-excluded paths and paths outside reserved workspace source roots are context-local scratch writes. Routed paths under reserved roots must use canonical casing and valid repo shape. Data may be a UTF-8 string or a base64 binary envelope. |
| `fs.appendFile` | Append data to the end of a context-root-relative file, creating the file and missing parent directories when absent. Managed workspace files are recorded as attributed semantic VCS operations before projection; platform-excluded paths and paths outside reserved workspace source roots remain context-local scratch. Routed paths under reserved roots must use canonical casing and valid repo shape. Data may be a UTF-8 string or a base64 binary envelope. |
| `fs.readdir` | List the entries of a directory; returns bare name strings, or Dirent-shaped objects with type flags when `withFileTypes` is set, optionally recursing into subdirectories. |
| `fs.mkdir` | Create a scratch directory directly on the context filesystem. Managed workspace paths reject mkdir because empty directories have no semantic fact; author a file instead and its parent directories are implicit. With `recursive`, scratch mkdir creates missing parents and returns the first-created path relative to the context root; otherwise it returns undefined. |
| `fs.rmdir` | Remove a directory. The semantic workspace records a managed subtree removal atomically before projection; a scratch directory is removed directly and throws if it is not empty. |
| `fs.rm` | Remove a file or directory; `recursive` deletes a directory's contents and `force` suppresses errors for missing paths. The semantic workspace records managed removals atomically before projection; scratch paths are removed directly. |
| `fs.stat` | Return metadata (type flags, size, mtime/ctime, mode) for a path, following symlinks to their target. |
| `fs.lstat` | Like stat, but reports on the symlink itself rather than following it to its target. |
| `fs.exists` | Return whether a path exists and is accessible to the caller. |
| `fs.access` | Test a path's accessibility against the given fs.constants mode bits; resolves on success, throws on failure. |
| `fs.unlink` | Delete a single file (not a directory). The semantic workspace records a managed deletion before projection; a scratch path is deleted directly. |
| `fs.copyFile` | Copy a file between context-root-relative paths. Managed destinations must be vacant: managed-to-managed copies mint a distinct file identity with exact copy provenance, while scratch-to-managed copies author an ordinary file creation caused by this copy invocation. Scratch content has no earlier semantic origin to preserve. Scratch destinations retain ordinary filesystem overwrite semantics. A platform-excluded destination or one outside reserved workspace source roots stays context-local scratch. Routed destinations under reserved roots must use canonical casing and valid repo shape. |
| `fs.rename` | Move or rename a context-root-relative file or directory. Scratch-to-scratch renames are direct. The semantic workspace records managed-to-managed moves before projection and preserves stable file identity. Generic scratch-to-managed rename is refused because a path cannot prove new-import versus trusted atomic-replacement intent; use `copyFile` for a vacant managed import or an explicit managed write/edit for replacement, and the refused rename leaves the scratch source intact. Moving a tracked managed path out to scratch is also refused. Routed endpoints under reserved workspace source roots must use canonical casing and valid repo shape. |
| `fs.realpath` | Resolve a path to its canonical form, returning it relative to the context root (sandboxed callers) or as an absolute host path (unrestricted callers). |
| `fs.ensureMaterialized` | Materialize the given workspace path(s)/repo(s) (or 'all') into the context working folder. Context folders are SPARSE — only what is materialized exists on disk — so call this for the narrowest scope you need (a repo path like 'panels/chat', a section like 'panels', or specific paths) before reading them OUTSIDE the fs.* API (e.g. a grep/find subprocess). fs.* reads materialize on demand automatically. |
| `fs.truncate` | Truncate (or zero-extend) a file to the given byte length (default 0). The semantic workspace records a managed file update before projection; a scratch file is changed directly. |
| `fs.readlink` | Read a symlink's target; absolute targets are relativized to the context root to avoid leaking host paths. |
| `fs.symlink` | Create a symbolic link inside context-local scratch. Both the link and its resolved target must remain inside the caller's context root; absolute-looking targets are interpreted relative to that virtual root and stored as contained relative targets. Managed workspace link paths are rejected because the semantic file manifest does not represent symlink entries. |
| `fs.chmod` | Change a path's Unix permission bits (mode). The semantic workspace records a managed file mode change before projection; a scratch path is changed directly. |
| `fs.utimes` | Set a path's access and modification timestamps (seconds since the epoch) directly on the context filesystem projection; timestamps carry no semantic workspace fact. |
| `fs.grep` | Search file contents under the context root with the bundled ripgrep engine for a regex pattern (the first argument), returning bounded matching lines in deterministic path/line order with optional context. Respects .gitignore/.ignore by default and always skips .git, .gad, node_modules, symlinks, and binary files. |
| `fs.glob` | Find regular files whose path matches a glob pattern (the first argument) under the context root, returned in deterministic lexical traversal order. Results are bounded and resumable. Respects .gitignore/.ignore by default and always skips .git, .gad, node_modules, and symlinks. |
| `fs.open` | Open a file with the given flags (default 'r') and optional mode, returning a server-tracked handleId for subsequent handleRead/handleWrite/handleStat/handleClose calls; handles are caller-scoped and auto-close after 5 minutes idle. For context-bound callers, write-capable flags are supported for scratch paths only and are rejected for GAD-tracked workspace-repo paths. |
| `fs.handleRead` | Read up to `length` bytes from an open handle at the given position (null reads from the current offset), returning the bytes base64-encoded plus the count actually read. |
| `fs.handleWrite` | Write data (UTF-8 string or base64 binary envelope) to a write-capable handle at the given position (null uses the current offset), returning the byte count written. Context-bound callers cannot open GAD-tracked workspace-repo paths with write-capable flags, so their handle writes are scratch-only. |
| `fs.handleClose` | Close an open file handle and release its server-side resources; a no-op if the handle is already gone. |
| `fs.handleStat` | Return metadata (type flags, size, mtime/ctime, mode) for the file behind an open handle. |
| `fs.mktemp` | Create the context's `.tmp/` directory if needed and return a fresh, unused root-relative scratch path under it (preferred for write-to-temp-then-rename patterns). The file itself is not created, the prefix is sanitized, and the path is not a tracked edit/VCS destination. |

## `gateway`

Loopback panel-asset fetch bridge (remote shells)

Authority principals: `code`, `user`

| Method | Description |
|--------|-------------|
| `gateway.fetch` | Loopback-fetch a panel asset from the server's own gateway and stream the Response back over the pipe's bulk channel (a streaming method). A request body streams IN over the same channel (stream-open bodyStreamId → ctx.body). |

## `governance`

Host governance log — approval provenance + membership events (read-only)

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `governance.list` | List host governance records (approval resolutions + membership events) newest-first, optionally filtered by record kind, acting user, approval kind, membership op, workspace, or grant outcome. |

## `hostLifecycle`

Host-process graceful shutdown for attached shells

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `hostLifecycle.shutdown` | Gracefully shut down the workspace server process (same path as SIGTERM). Shell-only. |

## `hostPerformance`

Bounded workspace host and workerd performance diagnostics

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `hostPerformance.snapshot` | Capture workspace-server memory/CPU counters, retained event-loop responsiveness samples, and workerd RSS/occupancy. Pass since to correlate samples with one workload. |

## `mirror`

Read-side of the context projector: `targets` returns a context's per-repo content-addressed states, `objects` streams the CAS tree content for a state in size-bounded pages. Powers `vibestudio context mirror`.

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `mirror.targets` | Return repository content projections for a context's exact working head. Each {repoPath,stateHash} is a content-only projector target, never ancestry or a semantic revision. Stream its immutable tree through `objects`. |
| `mirror.objects` | Stream one content-only repository tree as bounded pages of {path,mode,content,size}. Agent callers may read only states currently reachable from their host-bound context; no prior `targets` call is required. A stateHash never grants workspace history or provenance. Page with `next` until absent and optionally restrict to paths. |

## `notification`

Push notifications to the shell chrome area

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `notification.show` | Show a notification in the shell chrome; returns a host-issued id attributed to the verified caller. |
| `notification.dismiss` | Dismiss a notification previously issued to this caller, rejecting any pending waitForAction for it. |

## `panelCdp`

Approval-gated server CDP access for panel targets

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `panelCdp.getCdpEndpoint` | Return a single-use CDP WebSocket endpoint for an approved panel target. |
| `panelCdp.stop` | Stop loading an approved panel target through its active CDP host. |
| `panelCdp.consoleHistory` | Read console history from an approved panel target's active CDP host. |
| `panelCdp.evaluate` | Evaluate one expression in an approved panel target through its active CDP host. The expression runs under a bounded wrapper (8s) and the result is serialized to a string, so no CDP WebSocket client is needed for the common inspect-and-poke case. |
| `panelCdp.screenshot` | Capture a screenshot of an approved panel target through its active CDP host (force-paints hidden/unslotted panels). Returns base64 image data + mime type; no CDP WebSocket client needed. |
| `panelCdp.hostProvider.open` | Internal shell/server transport: open a streamed CDP host-provider channel. |
| `panelCdp.hostProvider.send` | Internal shell/server transport: deliver a CDP host-provider frame to the bridge. |
| `panelCdp.hostProvider.close` | Internal shell/server transport: close a CDP host-provider channel. |

## `panelContext`

Aggregate panel identity, tree position, and presentation lease

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `panelContext.describe` | Describe one panel: its slot and siblings, the code identity currently occupying it, and its presentation lease. Console counts and presentation-local address facts are reported as explicitly absent rather than guessed. |

## `panelLog`

Forward panel console errors and lifecycle events into unit diagnostics

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `panelLog.append` | Forward a batch of panel console/lifecycle records (max 200) from the Electron shell into the server's runtime-diagnostics store. |

## `panelRuntime`

Panel runtime lease coordination

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `panelRuntime.registerClient` | Register (or refresh) a panel-hosting client session so it can be assigned runtime leases. |
| `panelRuntime.unregisterClient` | Unregister a client session by id, releasing any leases it held and reassigning default CDP hosts as needed. |
| `panelRuntime.getSnapshot` | Get the current lease snapshot (version + all active panel runtime leases). |
| `panelRuntime.observeSlot` | Observe the canonical attempt, route, and build axes for one panel slot. |
| `panelRuntime.getAttempt` | Resolve one exact coordinator-minted panel attempt reference. |
| `panelRuntime.awaitAttempt` | Wait until an exact panel attempt advances beyond a known revision. |
| `panelRuntime.awaitSlot` | Wait until any axis of a panel slot observation advances beyond a version. |
| `panelRuntime.acquire` | Acquire the runtime lease for a panel entity. Succeeds for the current holder or an unleased entity; otherwise returns acquired:false with the existing lease. |
| `panelRuntime.takeOver` | Forcibly take over a panel entity's runtime lease, revoking and closing any conflicting holder's connection. |
| `panelRuntime.ensureSlot` | Ensure that the current runtime entity for a slot has a presentation host lease. |
| `panelRuntime.unloadSlot` | Release the active presentation lease for a panel slot while preserving its runtime entity and topology. |
| `panelRuntime.release` | Release the lease for a panel entity held by the given connection id. No-op unless the connection matches the current holder. |
| `panelRuntime.reportView` | Report the current page and boot observation for a leased panel from a host without an inspection transport. Returns stale when the lease was superseded before publication. |

## `permissions`

Trusted review and revocation of durable permission grants

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `permissions.list` | List active session and durable capability, userland, and credential-use grants. |
| `permissions.revoke` | Revoke one durable permission grant by its opaque id. |
| `permissions.listAgentProfiles` | List the living authority profile for every agent with standing permissions or locks. |
| `permissions.safetyStatus` | Read the live emergency authority state and the work it can immediately interrupt. |
| `permissions.listPendingRequests` | List the authority requests currently paused on a human decision, so the waiting count on the safety status can be read as work rather than as a number. |
| `permissions.updateAgentProfile` | Pause or resume an agent, revoke all of its authority, or change one lasting authority setting. |
| `permissions.setWorkspaceAuthorityLock` | Engage or release the emergency workspace lock for every agent's protected authority. |

## `presence`

Active shell/panel ownership

Authority principals: `host`, `user`

| Method | Description |
|--------|-------------|
| `presence.markPanelActive` |  |
| `presence.markPanelsOwned` |  |
| `presence.getPanelActiveOwner` |  |

## `push`

Push notification device registration and delivery

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `push.register` | Register a device's push token for a client id, persisting it so it survives server restarts. |
| `push.unregister` | Remove the persisted push registration for a client id; returns whether one existed. |

## `runtime`

Runtime entity creation and retirement

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `runtime.createEntity` | Create a runtime entity (panel, app, worker, DO, or session) and commit its durable identity. Omitted contextId inherits the verified caller's context; root callers without one mint a fresh context. A canonical key is an immutable identity and never silently switches source, context, or effective code version. Reuses or reactivates only a compatible row. Retirement does not release that identity; replacing an instance or launching edited disposable code requires a fresh key. Returns the entity handle (id + runtime targetId). |
| `runtime.reserveEntity` | Reserve a code-backed entity's stable durable identity and context without waiting for its immutable runtime image. Omitted contextId deterministically creates a fresh lifecycle-owned context; an explicit contextId shares that existing context. Reserved entities are non-executable until activateReservedEntity completes. |
| `runtime.activateReservedEntity` | Prepare and atomically activate the immutable runtime image for a previously reserved code-backed entity. |
| `runtime.retireEntity` | Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context. |
| `runtime.releaseResourceBindings` | Release every host-owned resource binding attached to one owned runtime entity. |
| `runtime.listEntities` | List exact live runtime instances (id, kind, source, key, contextId, title, createdAt). For declared source and build readiness use build.listUnits. |
| `runtime.resolveContext` | Return the contextId for an entity (or null if unknown). Cached read; falls back to DO. |
| `runtime.listContexts` | List durable semantic workspace contexts, optionally restricted to an exact id prefix. This is domain-neutral workflow discovery; context contents remain subject to their ordinary VCS read authority. |
| `runtime.createContext` | Create a full logical semantic workspace context. When invoked by a context-scoped runtime, the new context is recorded as that exact runtime entity's lifecycle child, making ownership, initialization authority, and teardown walkable instead of leaving an ownerless context island. Root host callers create root contexts. The state machine initializes one exact committed event and event/application working head over the whole workspace; later semantic operations advance that working head atomically. Use vcs.status for compact ancestry and integration orientation, then page repository and work membership through focused VCS inspectors. |
| `runtime.cloneContext` | Clone a context's durable state—every worker/DO store plus its exact committed event and event/application working head—into a fresh isolated context. Immutable semantic history and authored facts are shared by identity, not copied into a parallel snapshot history. Returns the new contextId and source-to-clone entity/context maps. With `recursive`, the whole lifecycle subtree is cloned (never following lineage edges); with `targetKey`, retry returns the same child. The caller performs per-entity rewiring such as fork-log re-rooting on the returned clones. |
| `runtime.destroyContext` | Retire every entity in a context and delete its folder + VCS state. With `recursive` (the default when lifecycle children exist), post-order teardown of the LIFECYCLE subtree only — never crossing a lineage (fork) edge. Free for your own context or one you fully own (every active entity was launched by you); gated when destroying another agent or panel's existing context. |
| `runtime.forkSemanticContext` | Fork one runtime's exact semantic context into one owned child context without materializing a host checkout. |
| `runtime.dropSemanticContext` | Drop one exact semantic-only context and remove its generic lifecycle ownership record. |
| `runtime.listOwnedContexts` | List the contexts owned by a context via the relationship registry. `kind` scopes to 'lifecycle' (subagent children) or 'lineage' (fork provenance); omit to list both. Returns { contexts: [...] }. |
| `runtime.recordContextEdge` | Idempotently upsert a context-relationship edge into the registry. Host-internal only; userland creates trusted edges through cloneContext/createSubagentContext instead. |
| `runtime.createSubagentContext` | Create a subagent's child context from a parent: validate the spawning owner, mint a deterministic child contextId from targetKey, fork the parent's committed event and exact event/application working head while retaining provenance lineage, ensure its projection directory, and record a 'lifecycle' edge (owner = parentContextId). Idempotent under targetKey. Composes context lifecycle and registry operations; callers must not hand-roll this. |
| `runtime.supervision.list` | List supervised executable entities through their exact driver identities. |
| `runtime.supervision.describe` | Describe one supervised entity, including immutable artifact identity and supported facets. |
| `runtime.supervision.health` | Read bounded health, failures, logs, and build events for one supervised entity. |
| `runtime.supervision.logs` | Read retained logs for one exact supervised entity. |
| `runtime.supervision.restart` | Restart one exact supervised entity through its owning driver. |
| `runtime.supervision.activate` | Activate one exact admitted app or extension release. |
| `runtime.supervision.prepare` | Prepare an immutable app release from a source ref. |
| `runtime.supervision.retire` | Retire one exact supervised entity through its owning driver. |
| `runtime.supervision.versions` | List retained versions for an exact release identity. |
| `runtime.supervision.rollback` | Roll back an exact release identity to a retained build. |

## `serverLog`

Server host log inspection and live tailing

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `serverLog.query` | Query the server host log ring buffer with filters (sinceSeq cursor, time range, min level, subsystem tag, substring). Returns the most recent matches in ascending seq order plus process metadata (workspaceId, serverBootId, pid, latestSeq). |
| `serverLog.tail` | Return the last N server host log records (default 500) in ascending seq order — the starting snapshot for a live tail; then subscribe to the server-log:append event and dedupe by seq. |
| `serverLog.stats` | Aggregate stats over the captured server host logs: buffer occupancy, total captured this boot, counts by level, and the top subsystem tags. |

## `shellApproval`

Shell-owned consent approval queue

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `shellApproval.resolve` | Record the user's decision (once/session/version/deny/dismiss) on a pending approval, resolving its queued request. |
| `shellApproval.resolveInstallReview` | Accept a pending install review, allowing the selected parts and permissions now, or cancel it. |
| `shellApproval.resolveBootstrap` | Convergently resolve a snapshot of pending startup-app approvals. IDs already settled by an earlier partial attempt are reported as not pending so the remaining decisions can continue. |
| `shellApproval.submitClientConfig` | Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request. |
| `shellApproval.submitCredentialInput` | Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request. |
| `shellApproval.submitSecretInput` | Submit the user-entered secret field values for a pending secret-input approval, fulfilling its feedback-form request. |
| `shellApproval.listPending` | List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount. |
| `shellApproval.getWorkspaceCreationReviewState` | Return the host-owned preparation state for the workspace creation review without waiting for a human decision. |

## `shellPresence`

Tracks active shell clients for push notification delivery decisions

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `shellPresence.heartbeat` | Mark the calling shell active and return the current active-shell count. |

## `vcs`

One provenance-native workspace history: direct state nodes, local incremental integration, whole-chain commit/discard, explicit move/copy, and protected publication.

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `vcs.edit` | Atomically create repositories with their initial files or author exact text, binary, file-create, delete, and mode changes on the working head. |
| `vcs.move` | Move stable file or repository identities without reconstructing intent from bytes. |
| `vcs.copy` | Copy exact source files into new identities with immediate coordinate provenance. |
| `vcs.merge` | Merge one bounded page of stable coordinates from an exact event or external delta by net effect. |
| `vcs.revert` | Author explicit counteractions of exact semantic changes. |
| `vcs.commit` | Commit the complete local application chain; derive every integration parent from recorded merge decisions. |
| `vcs.discard` | Discard the complete uncommitted chain and return to the committed event. |
| `vcs.importSnapshot` | Import one exact complete external snapshot as ordinary changes on an import work unit and atomically return the committed event, application, work unit, admitted repository IDs, and canonical external snapshot. |
| `vcs.registerExternalDelta` | Register one exact unapplied old-to-new external repository delta. |
| `vcs.supersedeExternalDelta` | Retire one active external delta so it can no longer be merged. |
| `vcs.finalizeExternalDelta` | Finalize one fully decided external delta and release its dedicated GC roots. |
| `vcs.push` | Publish one exact already-committed event to protected main; epochTransition requests the reviewed host handoff for a foreign-epoch candidate. |
| `vcs.status` | Return context pointers, clean state, main relation, and compact working counts. |
| `vcs.compare` | Compare an exact target state with a committed source event or coordinator-owned external delta by semantic change. |
| `vcs.inspect` | Inspect one typed semantic node and a bounded preview of its direct adjacency. |
| `vcs.neighbors` | Page immediate typed provenance edges without persisting traversal state. |
| `vcs.history` | Page event history in either direction or past file history from one exact state. |
| `vcs.walk` | Run one curated multi-hop provenance traversal (cause, cohort, rejections) with server-owned depth and fan-out bounds. |
| `vcs.query` | Run one caller-scoped read-only SELECT against the versioned prov_* views; canonical tables stay private. |
| `vcs.search` | Find semantic subjects by their recorded prose (intents, rationales, event messages, trigger excerpts). |
| `vcs.blame` | Trace an exact bounded file range through immediate content-coordinate mappings. |
| `vcs.readMemory` | Project bounded blame-backed workspace memory for the exact text range and content hash returned by a managed file read. |
| `vcs.resolveRepository` | Resolve one canonical repository path at one exact semantic state. |
| `vcs.readFile` | Read one file from an exact semantic state. |
| `vcs.listDirectory` | Page immediate visible children of one workspace directory with stable identities and attached name provenance. |
| `vcs.listFiles` | Page the exact path-to-file manifest of one repository at one semantic state. |

## `workerdInspector`

Approval-gated workerd V8 inspector access for profiling workers and DOs

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `workerdInspector.listTargets` |  |
| `workerdInspector.getEndpoint` |  |

## `workerLog`

Forward DO console output to the server terminal and the workspace-unit log stream

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `workerLog.write` | Forward one DO console line (level + message, plus optional source) to the server terminal and the workspace-unit log stream. |

## `workers`

Worker discovery and workspace service resolution

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `workers.listSources` | List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers) |
| `workers.listServices` | List manifest-declared workspace services visible in the caller's live context; rows include the live docs catalog id. In eval import the top-level workers API from @workspace/runtime. Inside an installed worker, call runtime.workers.listServices() on the createWorkerRuntime(env) result; never construct a worker runtime from eval. |
| `workers.resolveService` | Resolve a live workspace service by name or protocol. In eval use the top-level workers import from @workspace/runtime; inside an installed worker use runtime.workers on the createWorkerRuntime(env) result. The returned target is called through the matching top-level or worker-runtime rpc API. |
| `workers.resolveDurableObject` | Resolve and activate a concrete Durable Object RPC target by source/class/key when no declared workspace service fits. The returned target is a lifecycle handle as well as an RPC address: when the caller owns a disposable object, clear any test data and pass that same target to workers.destroy(...) so its durable storage is retired. |
| `workers.resetStorage` | Back up, integrity-check, and reset one exact disposable Durable Object storage target. Intent is required audit context; this is not an upgrade path. |
| `workers.listStorageBackups` | List verified storage backups for one exact Durable Object target. |
| `workers.restoreStorageBackup` | Back up the current files, verify a named backup, and restore it to the same exact Durable Object target. |

## `workspace`

Current-workspace configuration, units, and lifecycle

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `workspace.getInfo` | Filesystem paths (source, state, contexts) and resolved config for the active workspace. |
| `workspace.getActive` | Name (id) of the currently active workspace. |
| `workspace.getConfig` | The active workspace's resolved config (meta/vibestudio.yml). |
| `workspace.validateConfig` | Validate a complete flattened workspace runtime manifest without changing workspace state. |
| `workspace.setInitPanels` | Replace the set of panels opened when this workspace starts; approval-gated for userland. |
| `workspace.setConfigField` | Write an arbitrary field into the workspace config (meta/vibestudio.yml); approval-gated for userland. |
| `workspace.applyPreparedConfig` | Atomically apply a complete validated workspace configuration only when its base digest, result digest, and changed-path scope match. |
| `workspace.getAgentsMd` | Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent. |
| `workspace.listSkills` | List repo-embedded workspace skills with identity, paths, and optional onboarding declarations parsed from each repo's top-level SKILL.md frontmatter. Context-bound runtimes use their verified ambient context; contextless host clients must provide an explicit contextId. |
| `workspace.readSkill` | Return raw SKILL.md contents for a canonical workspace repo path (`skills/code-review`, `packages/foo`, `workers/bar`, or `meta`). Path traversal is rejected. Context-bound runtimes use their verified ambient context; contextless host clients must provide an explicit contextId. |
| `workspace.sourceTree` | Return the workspace source tree, annotating units, launchables, and skills. |
| `workspace.ensureContextFolder` | Materialize a context's working folder on the server host (idempotent) and return its absolute path. Used by launch orchestrators (e.g. the shell extension) to place context-scoped terminal sessions inside a real VCS-branched working tree. |
| `workspace.findUnitForPath` | Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it. |

## `workspacePresence`

Who is connected to this workspace (WP8 §4 host presence — session-derived, zero channel coupling)

Authority principals: `code`, `host`, `user`

| Method | Description |
|--------|-------------|
| `workspacePresence.list` | List the users with ≥1 live human connection to this workspace, plus recently-departed users with a last-seen time (WP8 §4 host presence). Fed only by the session registry — carries no channel/conversation data. |

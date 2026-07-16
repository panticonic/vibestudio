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

Some internal services (e.g. workerd) are not shell-callable and do not appear
here. Create workers and DOs via `runtime.createEntity` (`kind: "worker"` /
`"do"`), then dispatch to them with `--target` relay calls.

## `account`

Read-only live account profiles for this workspace

Allowed callers: `server`, `shell`, `app`, `panel`

| Method | Description |
|--------|-------------|
| `account.getProfile` | Resolve one account's live profile (defaults to the caller's own subject). Returns null for an unknown userId. |
| `account.resolveProfiles` | Batch-resolve userIds to live profiles for rendering user participants. Unknown ids are absent from the result. |
| `account.isMember` | Return whether a user belongs to this child server's bound workspace. The workspace is host-bound, never caller-selected. |
| `account.listWorkspaceMembers` | List live account profiles for this child server's bound workspace, including implicit root membership. |

## `audit`

Audit log query access

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `audit.query` |  |

## `auth`

Gateway authentication bootstrap routes

Allowed callers: `server`, `shell`

| Method | Description |
|--------|-------------|
| `auth.grantConnection` | Mint a short-lived connection token for a panel/app caller (requires the panel-hosting capability), granting it access to the gateway. |
| `auth.getConnectionInfo` | Report how clients should reach this gateway: server/connect URLs, protocol, server identity, and current workspace. |

## `blobstore`

Per-workspace content-addressable blob storage

Allowed callers: `panel`, `app`, `worker`, `do`, `shell`, `server`, `extension`

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

## `build`

Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `build.getBuild` | Build a panel/worker/extension unit (or a library bundle) and return its artifacts. The optional ref selects the workspace state to build from: omitted = main HEAD, a head name (e.g. 'ctx:abc'), or an immutable 'state:…' hash. Results are cached by content-derived build key, so rebuilding an unchanged unit reuses the cache. |
| `build.getBuildNpm` | Build an npm package as a CJS library bundle for sandbox use, leaving the given externals unbundled. |
| `build.getBuildMetadata` | Cached build metadata for an immutable build key, or null if it is not cached. Includes the unit's most recent structured build diagnostics (esbuild + tsc) when any were captured. |
| `build.getBuildReport` | Explicitly build a unit (runtime, or library targets for packages) at the requested workspace state and return an agent-actionable unit build report with structured esbuild + tsc diagnostics. This advisory projection does not publish source, authorize publication, or advance any head. |
| `build.getEffectiveVersion` | Effective version (content-derived identity) of a workspace unit, or null if unknown. |
| `build.inspectBuildProvenance` | Resolve a workspace build unit (by name, relative path, or basename) and report its effective version, immutable build keys, and cached artifact metadata. Reports ambiguity when a basename matches multiple units. |
| `build.listRecentBuildEvents` | List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path. |
| `build.doctorExtension` | Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status. |
| `build.recompute` | Rediscover the package graph, recompute every unit's effective version, rebuild any changed buildable units, and return the set of changed/added/removed units. |
| `build.gc` | Garbage-collect cached build artifacts not referenced by the given active units; returns the number of artifacts freed. |
| `build.getAboutPages` | List available about pages for the launcher UI. |
| `build.hasUnit` | Whether a build unit with this name exists in the workspace graph. |
| `build.getPanelMetadata` | Launcher metadata (source path, title, description, launcher visibility) for a panel unit, or null if the name is absent or not a panel. |
| `build.listSkills` | List available workspace skill packages that can be loaded via the eval imports parameter. |

## `credentials`

URL-bound userland credential storage and egress

Allowed callers: `shell`, `app`, `panel`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `credentials.storeCredential` | Persist a URL-bound credential (label, audience, injection, secret material); userland callers are prompted to approve it before it is stored, and the returned summary never echoes the secret. |
| `credentials.connect` | Run a connection flow (OAuth2/OAuth1a/API-key/SSH/browser-session) to obtain and store a credential; interactive flows open a browser sign-in and may return a DeferredResult for hibernatable DO callers. |
| `credentials.configureClient` | Store (versioned) OAuth client configuration — authorize/token URLs and client fields such as client id/secret; userland callers are prompted to submit the material, and secrets are never returned in the status. |
| `credentials.requestCredentialInput` | Prompt the user to enter exactly one secret field, then store the resulting credential; the submitted secret is never returned in the summary. |
| `credentials.getClientConfigStatus` | Return the configured status of an OAuth client config (which fields are set, URLs, status) without revealing secret values; rejects callers outside the config's trust scope. |
| `credentials.deleteClientConfig` | Disable a client config (marks it deleted so it is no longer used for new connections or refreshes); userland callers are prompted to confirm and only the config's owner may delete it. |
| `credentials.forwardOAuthCallback` | Deliver an inbound OAuth provider callback (code/state, or a full callback URL) to its pending connection transaction, validating the caller against the transaction's redirect strategy. |
| `credentials.cancelOAuth` | Cancel a pending interactive OAuth connection transaction. |
| `credentials.listStoredCredentials` | List summaries of stored URL-bound credentials visible to the caller; secret material is never included. |
| `credentials.inspectStoredCredentials` | List administrator-facing credential summaries with runtime usage metadata; secret material is never included. |
| `credentials.revokeCredential` | Revoke a stored credential by id (marks it revoked and best-effort revokes the upstream provider token); only an authorized administrator of the credential may call it. |
| `credentials.resolveCredential` | Locate a stored credential by url/provider/id and authorize its use for the caller, returning a summary, null when nothing matches, or a DeferredResult while a use-approval prompt is awaited. |
| `credentials.proxyFetch` | Forward an outbound HTTP request through the egress proxy, injecting the resolved credential; returns status, ordered header pairs, final URL, and a base64 body. |
| `credentials.proxyGitHttp` | Forward a Git smart-HTTP request through the egress proxy with credential injection; the request/response bodies are base64-encoded. |
| `credentials.completeCapture` | Complete a pending server-initiated session credential capture (`credential:capture-request` event) with the captured material or an error; callable only by the attached desktop shell. |
| `credentials.audit` | Query the credential egress audit log (optionally filtered by provider/connection/caller/since, paged by limit/after). |

## `docs`

Agent-facing capability catalog: discover services and runtime APIs with typed schemas, access rules, and examples (results filtered to what the caller may invoke).

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `server`, `shell`, `agent`

| Method | Description |
|--------|-------------|
| `docs.search` | Search the capability catalog (services and runtime APIs) by keyword. Results are filtered to what the calling kind may invoke. Use docs.describe(id) for the full typed schema, access rules, and examples. |
| `docs.describe` | Return the full catalog entry for an id (typed args/returns schema, access/restrictedness, examples). Returns null if unknown or not visible to the caller. |
| `docs.getSchema` | Return just the args/returns JSON Schema for a catalog id. |
| `docs.listSurfaces` | List catalog surfaces and the number of entries the caller can see in each. |
| `docs.listServices` | List registered RPC services and their methods (per-service view with JSON-Schema args/returns), filtered to what the calling kind may invoke. Every service.method listed is callable as services.<service>.<method>(...). |
| `docs.describeService` | Describe one registered RPC service by name: its policy and every method the caller may invoke (with JSON-Schema args/returns). Returns null for an unknown service. |

## `eval`

Owner-scoped sandbox eval backed by a per-owner internal EvalDO

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `shell`, `server`, `agent`

| Method | Description |
|--------|-------------|
| `eval.run` | Run TypeScript/JS in the caller's per-owner EvalDO sandbox (persistent REPL scope + synchronous in-DO SQLite `db`). Set reset:true to atomically clear scope/db before this run. Owner is the verified caller; fs is scoped to the owner's context. |
| `eval.reset` | Reset the eval context: wipe the persistent scope + the user `db` tables (a fresh scope), preserving the kernel's own state. The owner's existing data is cleared. |
| `eval.startRun` | Start an eval run for a caller that cannot hold a connection (an agent DO): returns a runId at once; reset:true atomically clears scope/db before the idempotent run is first inserted. The eval runs server-held in the EvalDO and the result is delivered out-of-band (onEvalComplete) and/or polled via getRun. Connection-holding callers (panels/CLI) should use `run` for a one-request result. |
| `eval.getRun` | Poll an async run started with startRun: returns its status, latest durable progress heartbeat, and (when done) result. |
| `eval.readScopeTextPage` | Read a bounded page from a string in the caller's current durable eval scope. Use this to retrieve a large eval result losslessly after an eval caches it under a scope key; pages are UTF-16LE base64 so every JavaScript string code unit round-trips exactly. |
| `eval.deleteScopeValue` | Delete one value from the caller's current durable eval scope and persist the deletion. Intended for cleaning up temporary keys used by lossless large-result paging. |
| `eval.cancel` | Cancel a single in-flight or pending run by runId (CAS to cancelled, then abort its outbound calls so a run wedged on an rpc.call unwinds). Other runs and the persistent scope are untouched. A no-op if the run is already terminal. |

## `externalOpen`

Approval-gated system browser opens

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `externalOpen.openExternal` | Open an http(s) or mailto URL in the host OS browser; approval-gated for code callers, returning the persisted approval decision when one was made. |

## `fs`

Filesystem operations. Context-bound callers are sandboxed to their context folder; the semantic workspace records managed reads and mutations before host projection, with structured move/copy preserving explicit provenance. Scratch-only adapters may access context-local paths outside reserved workspace source roots and fail closed for managed paths. An unchained extension granted the explicit host-fs-access capability is unrestricted and uses host filesystem paths.

Allowed callers: `panel`, `app`, `server`, `worker`, `do`, `extension`, `shell`, `agent`

| Method | Description |
|--------|-------------|
| `fs.readFile` | Read a file's contents. Managed workspace files are resolved through the semantic authority at the context's exact working head, so projected disk bytes are never treated as authoritative; scratch paths read directly from the context filesystem. Overloaded: with an encoding string (or Node-style `{ encoding: "utf8" }`) the bytes are decoded and returned as a string; without one, raw bytes are returned base64-encoded in a binary envelope. (Server/shell callers prepend a contextId as the first argument.) |
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
| `fs.grep` | Search file contents under the context root for a regex pattern (the first argument), returning matching lines with optional context; uses ripgrep when available with a pure-JS fallback, skipping .git, node_modules, symlinks, and binary files. |
| `fs.glob` | Find files whose path matches a glob pattern (the first argument) under the context root, returned newest-first by mtime; skips .git, node_modules, and symlinks. |
| `fs.open` | Open a file with the given flags (default 'r') and optional mode, returning a server-tracked handleId for subsequent handleRead/handleWrite/handleStat/handleClose calls; handles are caller-scoped and auto-close after 5 minutes idle. For context-bound callers, write-capable flags are supported for scratch paths only and are rejected for GAD-tracked workspace-repo paths. |
| `fs.handleRead` | Read up to `length` bytes from an open handle at the given position (null reads from the current offset), returning the bytes base64-encoded plus the count actually read. |
| `fs.handleWrite` | Write data (UTF-8 string or base64 binary envelope) to a write-capable handle at the given position (null uses the current offset), returning the byte count written. Context-bound callers cannot open GAD-tracked workspace-repo paths with write-capable flags, so their handle writes are scratch-only. |
| `fs.handleClose` | Close an open file handle and release its server-side resources; a no-op if the handle is already gone. |
| `fs.handleStat` | Return metadata (type flags, size, mtime/ctime, mode) for the file behind an open handle. |
| `fs.mktemp` | Create the context's `.tmp/` directory if needed and return a fresh, unused root-relative scratch path under it (preferred for write-to-temp-then-rename patterns). The file itself is not created, the prefix is sanitized, and the path is not a tracked edit/VCS destination. |

## `gateway`

Loopback panel-asset fetch bridge (remote shells)

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `gateway.fetch` | Loopback-fetch a panel asset from the server's own gateway and stream the Response back over the pipe's bulk channel (a streaming method). A request body streams IN over the same channel (stream-open bodyStreamId → ctx.body). |

## `gitInterop`

External Git interop: declared remotes and remote project imports

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `gitInterop.setSharedRemote` | Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/vibestudio.yml and syncing it into the repo's git config; may prompt for capability approval. |
| `gitInterop.removeSharedRemote` | Remove a named shared Git remote declaration for a workspace unit from meta/vibestudio.yml and sync the repo's git config; may prompt for capability approval. |
| `gitInterop.setUpstream` | Declare or update upstream tracking for a workspace repo, persisting it to meta/vibestudio.yml; may prompt for capability approval. No network egress happens here. |
| `gitInterop.removeUpstream` | Remove upstream tracking for a workspace repo from meta/vibestudio.yml; may prompt for capability approval. |
| `gitInterop.detachUpstream` | Atomically remove upstream tracking (and optionally the declared remote) for a workspace repo in one config write and one approval; may prompt for capability approval. |
| `gitInterop.setAutoPush` | Toggle optional outgoing Git push for future exports of already-published protected main, persisting the change to meta/vibestudio.yml; this never publishes import candidates and may prompt for capability approval. |
| `gitInterop.upstreamStatus` | Return external Git upstream status for tracked repos, including integration-required candidate coordinates. The configured gitInterop provider performs any Git/network work. |
| `gitInterop.pushUpstream` | Export protected main and push it to the repo's declared upstream through the configured gitInterop provider; refuse while an external snapshot candidate requires semantic integration. |
| `gitInterop.pullUpstream` | Fetch a declared upstream and import its exact snapshot as a semantic candidate. Reconcile and publish it only through vcs.compare, incremental vcs.integrate, vcs.commit, and vcs.push. |
| `gitInterop.publishRepo` | Create a provider repository, configure tracking, export protected main, and push through the configured gitInterop provider. |
| `gitInterop.createDisposableRemote` | Create a short-lived, credential-free smart-HTTP Git remote managed by this workspace host. Prefer publishToDisposableRemote(repoPath) for one-call verification. For a persistent stepwise flow, create a remote, call pushDisposableRemote(repoPath, url, branch), then inspect or remove it. |
| `gitInterop.publishToDisposableRemote` | Export one workspace repo, push it to a fresh credential-free host-managed smart-HTTP remote, verify the received commit count, and clean the remote up. This is the one-call development/system-verification path and does not replace or mutate the repo's declared upstream. |
| `gitInterop.pushDisposableRemote` | Export one workspace repo and push it to an existing host-managed disposable Git remote. The host verifies that the URL is an active disposable remote and returns the received commit count without removing it. |
| `gitInterop.inspectDisposableRemote` | Verify a host-managed disposable Git remote and return its branch head and total received commit count. |
| `gitInterop.removeDisposableRemote` | Delete a host-managed disposable Git remote before its automatic expiry. |
| `gitInterop.commitMapping` | Return the semantic-event↔Git commit mapping for a repo's checkout, read from Vibestudio-Event trailers (newest first). |
| `gitInterop.importProject` | Clone an external Git project, record its remote/upstream config, and return the semantic candidate context and event. The import does not publish protected main; use the ordinary VCS integration path. |
| `gitInterop.completeWorkspaceDependencies` | Ask the configured provider for upstream status, clone each supported declaration reported as not-materialized, and return one unpublished semantic candidate per successful import. Other reported states are skipped as already-materialized; candidates require ordinary VCS integration and explicit publication. |

## `governance`

Host governance log — approval provenance + membership events (read-only)

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `governance.list` | List host governance records (approval resolutions + membership events) newest-first, optionally filtered by record kind, acting user, approval kind, membership op, workspace, or grant outcome. |

## `hostLifecycle`

Host-process graceful shutdown for attached shells

Allowed callers: `shell`, `server`

| Method | Description |
|--------|-------------|
| `hostLifecycle.shutdown` | Gracefully shut down the workspace server process (same path as SIGTERM). Shell-only. |

## `mirror`

Read-side of the context projector: `targets` returns a context's per-repo content-addressed states, `objects` streams the CAS tree content for a state in size-bounded pages. Powers `vibestudio context mirror`.

Allowed callers: `shell`, `agent`, `do`, `server`, `panel`

| Method | Description |
|--------|-------------|
| `mirror.targets` | Return repository content projections for a context's exact working head. Each {repoPath,stateHash} is a content-only projector target, never ancestry or a semantic revision. Stream its immutable tree through `objects`. |
| `mirror.objects` | Stream one content-only repository tree as bounded pages of {path,mode,content,size}. Agent callers may read only states currently reachable from their host-bound context; no prior `targets` call is required. A stateHash never grants workspace history or provenance. Page with `next` until absent and optionally restrict to paths. |

## `notification`

Push notifications to the shell chrome area

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `notification.show` | Show a notification in the shell chrome; returns its id (auto-generated when not supplied). |
| `notification.dismiss` | Dismiss the notification with the given id, rejecting any pending waitForAction for it. |
| `notification.reportAction` | Report that the user took an action on a notification, emitting an event and resolving any pending waitForAction. |

## `panelCdp`

Approval-gated server CDP access for panel targets

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `agent`

| Method | Description |
|--------|-------------|
| `panelCdp.getCdpEndpoint` | Return a single-use CDP WebSocket endpoint for an approved panel target. |
| `panelCdp.navigate` | Navigate an approved browser panel target through its active CDP host. |
| `panelCdp.reload` | Reload an approved panel target through its active CDP host. |
| `panelCdp.goBack` | Drive browser history back on an approved panel target. |
| `panelCdp.goForward` | Drive browser history forward on an approved panel target. |
| `panelCdp.stop` | Stop loading an approved panel target through its active CDP host. |
| `panelCdp.consoleHistory` | Read console history from an approved panel target's active CDP host. |
| `panelCdp.screenshot` | Capture a screenshot of an approved panel target through its active CDP host (force-paints hidden/unslotted panels). Returns base64 image data + mime type; no CDP WebSocket client needed. |
| `panelCdp.hostProvider.open` | Internal shell/server transport: open a streamed CDP host-provider channel. |
| `panelCdp.hostProvider.send` | Internal shell/server transport: deliver a CDP host-provider frame to the bridge. |
| `panelCdp.hostProvider.close` | Internal shell/server transport: close a CDP host-provider channel. |

## `panelLog`

Forward panel console errors and lifecycle events into unit diagnostics

Allowed callers: `shell`, `server`

| Method | Description |
|--------|-------------|
| `panelLog.append` | Forward a batch of panel console/lifecycle records (max 200) from the Electron shell into the server's runtime-diagnostics store. |

## `panelRuntime`

Panel runtime lease coordination

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `panelRuntime.registerClient` | Register (or refresh) a panel-hosting client session so it can be assigned runtime leases. |
| `panelRuntime.unregisterClient` | Unregister a client session by id, releasing any leases it held and reassigning default CDP hosts as needed. |
| `panelRuntime.getSnapshot` | Get the current lease snapshot (version + all active panel runtime leases). |
| `panelRuntime.acquire` | Acquire the runtime lease for a panel entity. Succeeds for the current holder or an unleased entity; otherwise returns acquired:false with the existing lease. |
| `panelRuntime.takeOver` | Forcibly take over a panel entity's runtime lease, revoking and closing any conflicting holder's connection. |
| `panelRuntime.release` | Release the lease for a panel entity held by the given connection id. No-op unless the connection matches the current holder. |

## `panelTree`

Server-mediated panel tree handles and control operations

Allowed callers: `panel`, `worker`, `do`, `shell`, `server`, `app`

| Method | Description |
|--------|-------------|
| `panelTree.list` | List the children of a panel (or the root panels when the parent id is null/omitted). |
| `panelTree.roots` | List all root-level panels in the tree. |
| `panelTree.getTreeSnapshot` | Return a full snapshot of the panel tree (revision plus root panels). |
| `panelTree.getFocusedPanelId` | Return the id of the currently focused panel, or null if none is focused. |
| `panelTree.create` | Create a new panel from a workspace source path, optionally nested under a parent and focused. |
| `panelTree.ensureLoaded` | Ensure the panel's runtime is loaded (building/restoring it if needed) without changing focus. |
| `panelTree.focus` | Focus a panel, loading its runtime first if it is not already loaded. |
| `panelTree.getRuntimeLease` | Return the current runtime lease held on a panel (which host/connection owns it), or null if unleased. |
| `panelTree.getStateArgs` | Return the validated state-args currently bound to a panel. |
| `panelTree.setStateArgs` | Merge a patch into a panel's state-args (null removes a key); returns the full resulting validated state-args. |
| `panelTree.reload` | Reload a panel's view in place, keeping its current snapshot. |
| `panelTree.close` | Close a panel, removing it (and its subtree) from the tree. |
| `panelTree.archive` | Archive a panel, removing it from the active tree while preserving its history. |
| `panelTree.unload` | Unload a panel's runtime/view to free resources while keeping the panel in the tree. |
| `panelTree.movePanel` | Reparent and/or reposition a panel among its siblings (drag-and-drop move). |
| `panelTree.navigate` | Navigate an existing panel to a new source path (optionally changing ref/context), returning the new panel descriptor or null. |
| `panelTree.navigateHistory` | Move a panel backward (-1) or forward (1) through its navigation history, returning the resulting panel descriptor or null. |
| `panelTree.takeOver` | Take over a panel's runtime lease for the calling client, focusing it on this host. |
| `panelTree.openDevTools` | Open developer tools for a panel, optionally docked to a side or detached. |
| `panelTree.rebuildPanel` | Rebuild a panel's runtime artifacts from source without reloading its view. |
| `panelTree.rebuildAndReload` | Rebuild a panel's runtime artifacts from source and then reload its view. |
| `panelTree.updatePanelState` | Update a panel's live navigation state (url, page title, loading/back/forward flags) from the rendering surface. |
| `panelTree.snapshot` | Return a readable snapshot of one loaded panel, using its agent snapshot when available and accessibility-tree fallback otherwise. |
| `panelTree.callAgent` | Invoke a panel's in-process agent method (e.g. _agent.snapshot/_agent.tree/_agent.setMode) with optional arguments. |
| `panelTree.metadata` | Return the full Panel metadata for a panel id, or null if it does not exist. |
| `panelTree.getCollapsedIds` | Return the ids of panels that are currently collapsed in the tree UI. |
| `panelTree.setCollapsed` | Set whether a panel is collapsed in the tree UI. |
| `panelTree.expandIds` | Expand (un-collapse) a set of panels in the tree UI. |

## `permissions`

Trusted review and revocation of durable permission grants

Allowed callers: `shell`, `app`, `panel`, `server`

| Method | Description |
|--------|-------------|
| `permissions.list` | List active session and durable capability, userland, and credential-use grants. |
| `permissions.revoke` | Revoke one durable permission grant by its opaque id. |

## `phoneProvisioning`

Account-scoped proxy to phone capabilities on connected desktop clients

Allowed callers: `agent`, `panel`, `app`, `shell`

| Method | Description |
|--------|-------------|
| `phoneProvisioning.providers` | List account-scoped desktop capability providers that can access phones attached to them. |
| `phoneProvisioning.devices` | Discover Android and iOS devices through the selected desktop, including readiness and compatible app state. |
| `phoneProvisioning.install` | Install a compatible mobile app through the selected desktop, resolving release tooling lazily when possible. |
| `phoneProvisioning.openPairing` | Open a one-time pairing link on a phone through the selected desktop without returning or logging the link. |

## `presence`

Active shell/panel ownership

Allowed callers: `server`, `shell`

| Method | Description |
|--------|-------------|
| `presence.markPanelActive` |  |
| `presence.markPanelsOwned` |  |
| `presence.getPanelActiveOwner` |  |

## `runtime`

Runtime entity creation and retirement

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `runtime.createEntity` | Create a runtime entity (panel, app, worker, DO, or session) and commit its durable identity. Reuses/reactivates an existing row for the same canonical key. Returns the entity handle (id + runtime targetId). |
| `runtime.retireEntity` | Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context. |
| `runtime.listEntities` | List live entities (id, kind, source, contextId, title, createdAt). |
| `runtime.resolveContext` | Return the contextId for an entity (or null if unknown). Cached read; falls back to DO. |
| `runtime.createContext` | Create a full logical semantic workspace context. When invoked by a context-scoped runtime, the new context is recorded as that exact runtime entity's lifecycle child, making ownership, initialization authority, and teardown walkable instead of leaving an ownerless context island. Root host callers create root contexts. The state machine initializes one exact committed event and event/application working head over the whole workspace; later semantic operations advance that working head atomically. Use vcs.status for compact ancestry and integration orientation, then page repository and work membership through focused VCS inspectors. |
| `runtime.cloneContext` | Clone a context's durable state—every worker/DO store plus its exact committed event and event/application working head—into a fresh isolated context. Immutable semantic history and authored facts are shared by identity, not copied into a parallel snapshot history. Returns the new contextId and source-to-clone entity/context maps. With `recursive`, the whole lifecycle subtree is cloned (never following lineage edges); with `targetKey`, retry returns the same child. The caller performs per-entity rewiring such as fork-log re-rooting on the returned clones. |
| `runtime.destroyContext` | Retire every entity in a context and delete its folder + VCS state. With `recursive` (the default when lifecycle children exist), post-order teardown of the LIFECYCLE subtree only — never crossing a lineage (fork) edge. Free for your own context or one you fully own (every active entity was launched by you); gated when destroying another agent or panel's existing context. |
| `runtime.listOwnedContexts` | List the contexts owned by a context via the relationship registry. `kind` scopes to 'lifecycle' (subagent children) or 'lineage' (fork provenance); omit to list both. Returns { contexts: [...] }. |
| `runtime.recordContextEdge` | Idempotently upsert a context-relationship edge into the registry. Host-internal only; userland creates trusted edges through cloneContext/createSubagentContext instead. |
| `runtime.createSubagentContext` | Create a subagent's child context from a parent: validate the spawning owner, mint a deterministic child contextId from targetKey, fork the parent's committed event and exact event/application working head while retaining provenance lineage, ensure its projection directory, and record a 'lifecycle' edge (owner = parentContextId). Idempotent under targetKey. Composes context lifecycle and registry operations; callers must not hand-roll this. |

## `serverLog`

Server host log inspection and live tailing

Allowed callers: `shell`, `app`, `panel`, `server`, `worker`, `do`, `extension`, `agent`

| Method | Description |
|--------|-------------|
| `serverLog.query` | Query the server host log ring buffer with filters (sinceSeq cursor, time range, min level, subsystem tag, substring). Returns the most recent matches in ascending seq order plus process metadata (workspaceId, serverBootId, pid, latestSeq). |
| `serverLog.tail` | Return the last N server host log records (default 500) in ascending seq order — the starting snapshot for a live tail; then subscribe to the server-log:append event and dedupe by seq. |
| `serverLog.stats` | Aggregate stats over the captured server host logs: buffer occupancy, total captured this boot, counts by level, and the top subsystem tags. |

## `shellApproval`

Shell-owned consent approval queue

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `shellApproval.resolve` | Record the user's decision (once/session/version/deny/dismiss) on a pending approval, resolving its queued request. |
| `shellApproval.blockCapability` | Deny a pending capability request and remember that denial for this exact code version until revoked. |
| `shellApproval.resolveBootstrap` | Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval. |
| `shellApproval.resolveUserland` | Resolve a pending userland approval by selecting one of the presented option values (or 'dismiss'); rejects if the choice was not offered to the user. |
| `shellApproval.resolveExternalAgent` | Record the user's allow/deny verdict on a pending external-agent tool-use approval, resolving the relayed permission request. |
| `shellApproval.resolveExternalAgentByRequest` | Record the user's allow/deny verdict on a pending external-agent approval matched by (channelId, requestId, resolveToken) rather than approvalId — the inline conversation card knows the requestId and opaque resolve token, not the internal approvalId. Records a real verdict (unlike the quiet settle-elsewhere path). Returns whether a matching pending approval was resolved. |
| `shellApproval.submitClientConfig` | Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request. |
| `shellApproval.submitCredentialInput` | Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request. |
| `shellApproval.submitSecretInput` | Submit the user-entered secret field values for a pending secret-input approval, fulfilling its feedback-form request. |
| `shellApproval.listPending` | List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount. |

## `shellPresence`

Tracks active shell clients for push notification delivery decisions

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `shellPresence.heartbeat` |  |

## `vcs`

One provenance-native workspace history: direct state nodes, local incremental integration, whole-chain commit/discard, explicit move/copy, and protected publication.

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`, `agent`

| Method | Description |
|--------|-------------|
| `vcs.edit` | Atomically create repositories with their initial files or author exact text, binary, file-create, delete, and mode changes on the working head. |
| `vcs.move` | Move stable file or repository identities without reconstructing intent from bytes. |
| `vcs.copy` | Copy exact source files into new identities with immediate coordinate provenance. |
| `vcs.integrate` | Take one local adopt, reconcile, or decline step against an exact source event. |
| `vcs.revert` | Author explicit counteractions of exact semantic changes. |
| `vcs.commit` | Commit the complete local application chain; derive its unique integration parent from recorded decisions, or accept an explicit zero-change source. |
| `vcs.discard` | Discard the complete uncommitted chain and return to the committed event. |
| `vcs.importSnapshot` | Import one exact complete external snapshot as ordinary changes on an import work unit. |
| `vcs.push` | Publish one exact already-committed event to protected main. |
| `vcs.status` | Return context pointers, clean state, main relation, and compact working counts. |
| `vcs.compare` | Compare an exact target state with a committed source event by semantic change. |
| `vcs.inspect` | Inspect one typed semantic node and a bounded preview of its direct adjacency. |
| `vcs.neighbors` | Page immediate typed provenance edges without persisting traversal state. |
| `vcs.history` | Page event history in either direction or past file history from one exact state. |
| `vcs.blame` | Trace an exact bounded file range through immediate content-coordinate mappings. |
| `vcs.resolveRepository` | Resolve one canonical repository path at one exact semantic state. |
| `vcs.readFile` | Read one file from an exact semantic state. |
| `vcs.listFiles` | Page the exact path-to-file manifest of one repository at one semantic state. |

## `webhookIngress`

Generic public webhook ingress subscriptions

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `webhookIngress.createSubscription` | Create an owner-scoped public webhook subscription targeting a method in the caller's own source. In agent eval, use agent.describe().identity for target.source, target.className, and target.objectKey. |
| `webhookIngress.listSubscriptions` | List the caller's active webhook subscriptions (secrets redacted). Pass includeRevoked:true only for audit/history views. |
| `webhookIngress.revokeSubscription` | Revoke one caller-owned webhook subscription idempotently. |
| `webhookIngress.rotateSecret` | Rotate a caller-owned subscription secret, generating a strong secret when one is omitted. |

## `workerdInspector`

Approval-gated workerd V8 inspector access for profiling workers and DOs

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workerdInspector.listTargets` |  |
| `workerdInspector.getEndpoint` |  |

## `workerLog`

Forward DO console output to the server terminal and the workspace-unit log stream

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `workerLog.write` | Forward one DO console line (level + message, plus optional source) to the server terminal and the workspace-unit log stream. |

## `workers`

Worker discovery and workspace service resolution

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `workers.listSources` | List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers) |
| `workers.listServices` | List workspace-authored services declared in the manifest |
| `workers.resolveService` | Resolve a workspace service by name or protocol |
| `workers.resolveDurableObject` | Resolve a Durable Object RPC target by source/class/key |

## `workspace`

Current-workspace configuration, units, and lifecycle

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `workspace.getInfo` | Filesystem paths (source, state, contexts) and resolved config for the active workspace. |
| `workspace.getActive` | Name (id) of the currently active workspace. |
| `workspace.getConfig` | The active workspace's resolved config (meta/vibestudio.yml). |
| `workspace.setInitPanels` | Replace the set of panels opened when this workspace starts; approval-gated for userland. |
| `workspace.setConfigField` | Write an arbitrary field into the workspace config (meta/vibestudio.yml); approval-gated for userland. |
| `workspace.getAgentsMd` | Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent. |
| `workspace.listSkills` | List repo-embedded workspace skills with name, description, repo path, and SKILL.md path parsed from each repo's top-level SKILL.md frontmatter. |
| `workspace.readSkill` | Return raw SKILL.md contents for a canonical workspace repo path (`skills/code-review`, `packages/foo`, `workers/bar`, or `meta`). Path traversal is rejected. |
| `workspace.sourceTree` | Return the workspace source tree, annotating units, launchables, and skills. |
| `workspace.ensureContextFolder` | Materialize a context's working folder on the server host (idempotent) and return its absolute path. Used by launch orchestrators (e.g. the shell extension) to place context-scoped terminal sessions inside a real VCS-branched working tree. |
| `workspace.findUnitForPath` | Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it. |
| `workspace.units.list` | List operational status rows for all workspace units (panels, workers, extensions, apps), including build/health state. |
| `workspace.units.inspector` | Return the devtools inspector URL for a unit by name or source, or null if it has none. |
| `workspace.units.restart` | Restart a workspace unit through its owning manager. |
| `workspace.units.logs` | Query retained log records for a unit, optionally filtered by time/sequence cursor, level, and limit. |
| `workspace.units.diagnostics` | Return combined diagnostics for a unit: current status, recent logs, errors, build events, and buffer capacity. |
| `workspace.units.versions` | List the active build and retained previous versions for an app unit. This is read-only diagnostics and is available to every workspace caller; rollback remains ownership-restricted. |
| `workspace.units.rollback` | Roll an app unit back to a previous active build (or a specific build key); userland is restricted to managing its own app. |
| `workspace.units.bakeAppDist` | Bake an app unit's active approved build into a packaging payload directory; trusted-chrome callers only. |
| `workspace.recurring.list` | List declarative scheduled jobs from meta/vibestudio.yml with their durable run state (next/last run, failures, backoff). |
| `workspace.heartbeats.list` | List registered heartbeats with their schedule, channel binding, and run state. |
| `workspace.heartbeats.runNow` | Trigger a heartbeat tick immediately for the selected heartbeat. |
| `workspace.heartbeats.pause` | Pause the selected heartbeat so it stops ticking until resumed. |
| `workspace.heartbeats.resume` | Resume a paused heartbeat so it resumes its schedule. |
| `workspace.hostTargets.list` | List app candidates selectable as the active app for a host target. |
| `workspace.hostTargets.getSelection` | Read the active per-workspace selection for a host target along with whether it is still valid. |
| `workspace.hostTargets.setSelection` | Persist the per-workspace app selection for a host target. |
| `workspace.hostTargets.clearSelection` | Clear the persisted per-workspace app selection for a host target. |
| `workspace.hostTargets.versions` | List retained versions for a specific host-target candidate. |
| `workspace.hostTargets.preparePinnedRef` | Materialize a retained build for a specific ref of a host-target candidate through the build system. |
| `workspace.hostTargets.launch` | Launch or reload the selected target app in this host, returning a ready/preparing/approval-required/unavailable status. |
| `workspace.hostTargets.beginLaunch` | Begin an asynchronous launch session for a host target, returning the initial session snapshot. |
| `workspace.hostTargets.getLaunchSession` | Fetch the current snapshot of a launch session by id, or null if it is unknown. |
| `workspace.hostTargets.resolveLaunchSessionApproval` | Resolve a pending approval on a launch session by allowing it once or denying it, returning the updated snapshot. |
| `workspace.hostTargets.cancelLaunchSession` | Cancel an in-flight launch session by id. |

## `workspace-state`

Workspace slot/entity state (WorkspaceDO).

Allowed callers: `shell`, `app`, `server`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workspace-state.slot.list` | List open slots. |
| `workspace-state.slot.get` | Get a single slot row by id. |
| `workspace-state.slot.history` | Get the history for a slot. |
| `workspace-state.entity.resolveActive` | Resolve a single active entity record by id. |
| `workspace-state.slot.resolveByEntity` | Resolve the OPEN slot id whose current entity is the given runtime-entity (nav) id, or null. Durable nav→slot mapping used to nest launches under the owning panel's tree slot. |
| `workspace-state.slot.create` | Create a new slot row. |
| `workspace-state.slot.appendHistory` | Append a history entry to a slot. |
| `workspace-state.slot.setCurrent` | Move a slot's current pointer to an existing history entry. |
| `workspace-state.slot.updateCurrentStateArgs` | Mutate the stateArgs for a slot's current history entry. |
| `workspace-state.slot.replaceHistory` | Replace a slot's history with the given entries and cursor. |
| `workspace-state.slot.setParent` | Reparent a slot. |
| `workspace-state.slot.setPosition` | Update a slot's position rank. |
| `workspace-state.slot.move` | Atomically update a slot's parent and position. |
| `workspace-state.slot.close` | Mark a slot closed. |
| `workspace-state.panel.search` | FTS5 search over panel entities. |
| `workspace-state.panel.index` | Upsert a panel's search-metadata row. |
| `workspace-state.panel.updateTitle` | Update the searchable title for a panel entity. |
| `workspace-state.panel.incrementAccess` | Bump the access counter for a panel entity. |
| `workspace-state.panel.rebuildIndex` | Rebuild the panel-search index from active panel entities. |

## `workspacePresence`

Who is connected to this workspace (WP8 §4 host presence — session-derived, zero channel coupling)

Allowed callers: `server`, `shell`, `app`, `panel`

| Method | Description |
|--------|-------------|
| `workspacePresence.list` | List the users with ≥1 live human connection to this workspace, plus recently-departed users with a last-seen time (WP8 §4 host presence). Fed only by the session registry — carries no channel/conversation data. |

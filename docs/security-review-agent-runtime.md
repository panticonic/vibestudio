# Security review: agent execution, tools, workspaces, and runtime boundaries

Date: 2026-07-27\
Scope: agent/eval execution, external agent launches, tool authorization, direct RPC, terminal and shell execution, filesystem confinement, egress and credential mediation, content provenance, lifecycle cleanup, and diagnostic artifacts.

## Executive assessment

The native Pi/EvalDO path has a strong security shape: identity is host-derived, managed filesystem writes require exact causal authority, model credentials remain server-side, worker egress is attributed, and external content advances a durable provenance latch before it is exposed to the model. Those controls are materially better than prompt-level “be safe” conventions.

Four verified boundary defects nevertheless undermine that model:

| ID   | Severity     | Finding                                                                                                                                                                                                                                                                                  | Confidence |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AR-1 | **Critical** | A linked headless Claude process receives the trusted extension's bearer environment, a read-only mount of the entire host, and unrestricted host networking. The “read-only context” sandbox therefore prevents writes but not host-secret disclosure or extension impersonation.       | High       |
| AR-2 | **Critical** | Arbitrary authenticated participants may directly call a terminal panel; the panel discards the original caller and acts as a deputy for shell sessions it owns. A participant can enumerate sessions, read scrollback, and inject terminal input without the command approval boundary. | High       |
| AR-3 | **High**     | Shell approval presentation is not the command that `shell:true` executes. Raw arguments are concatenated into a script after being displayed as quoted literals; caller-controlled environment overrides can also change executable meaning without appearing in the approval.          | High       |
| AR-4 | **High**     | Host-buffered and streamed proxy fetches can automatically follow redirects after authorizing only the first URL. Redirects can cross raw-egress origins, internal-network boundaries, or credential path audiences without a new authorization decision.                                | High       |
| AR-5 | **Medium**   | Timed shell exec does not own a process tree, and its SIGKILL fallback checks `child.killed` rather than exit state. Commands can outlive their advertised timeout or leave descendants behind.                                                                                          | High       |

The recommended response is not to reduce agent usefulness, disable direct collaboration, or add method blacklists. The clean synthesis is to make four abstractions truthful:

1. an external-agent launch owns an explicit filesystem, environment, network, and process-tree envelope;
2. receiver contracts preserve the original caller or require an explicit delegation;
3. an approved execution intent is the exact byte-level intent that is executed;
4. network authority is evaluated at every redirect hop.

These abstractions keep normal same-context reads, shells, redirects, and agent collaboration frictionless. Prompts should appear only when authority actually widens.

## Review model

### Security invariants used

The repository's own security model states:

- tokens authenticate but do not themselves authorize (`workspace/skills/architecture/SECURITY.md:6-20`);
- original caller/session facts must propagate through closure legs, and an intermediary must not substitute its own principal (`workspace/skills/architecture/SECURITY.md:60-63`);
- credentials are URL-bound, host-mediated, and never returned as secret bytes to userland (`workspace/skills/architecture/SECURITY.md:74-79`);
- external content advances a monotone session latch before exposure (`workspace/skills/architecture/SECURITY.md:81-106`);
- an agent is intended to have a context-scoped filesystem, no credential material, mediated egress, and receiver-side checks on sensitive effects (`workspace/skills/architecture/SECURITY.md:108-115`).

The findings below are measured against those intended invariants rather than against a weaker assumption that every authenticated runtime is mutually trusted.

### Adversaries considered

- prompt injection in web pages, repository content, channel messages, or a delegated task;
- a model or agent that makes an unsafe tool decision;
- a malicious or compromised authenticated workspace participant;
- a compromised external-agent subprocess;
- a remote server that controls redirect responses.

A local operating-system attacker already able to act as the Vibestudio user's UID is not treated as a distinct isolation tenant. However, a deliberately sandboxed model subprocess is treated as less trusted than the extension host that launched it; otherwise the sandbox and scoped agent credential have no security meaning.

### Severity meaning

- **Critical:** crosses a principal or host boundary and enables unapproved host command execution, broad secret access, or trusted-principal impersonation.
- **High:** reliably bypasses a security decision or audience boundary with material confidentiality/integrity impact.
- **Medium:** violates a bounded lifecycle or evidence guarantee and can cause persistent or operationally significant harm.

## Verified findings

## AR-1 — Linked Claude inherits host visibility and the extension principal

**Severity:** Critical\
**Confidence:** High\
**Status:** Accepted risk as of 2026-07-27; containerization is the intended boundary

### Evidence

The linked-Claude confinement helper describes its goal as a read-only managed projection, but actually mounts `/` read-only:

- `packages/shared/src/claudeReadOnlyLaunch.ts:34-45` describes the host tree as read-only and the launch as an OS boundary.
- `packages/shared/src/claudeReadOnlyLaunch.ts:68-99` invokes bubblewrap with `--ro-bind / /`.
- The launch does not unshare or mediate networking (`packages/shared/src/claudeReadOnlyLaunch.ts:68-99`).

The headless subagent launch then inherits the extension host's complete environment:

- `workspace/extensions/claude-code/index.ts:322-332` builds the Claude argv and spawns with `env: { ...process.env, ...materialized.env, ...confined.env }`.
- Every extension child receives a bearer for the trusted extension identity in `VIBESTUDIO_EXTENSION_RPC_TOKEN` and its gateway URL (`packages/extension-host/src/processManager.ts:68-88`).
- The extension runtime uses that bearer to establish authenticated RPC as the extension (`packages/extension-host/src/childRuntime.ts:516-548`).

The child also receives native Bash and defaults to autonomous permission handling:

- `workspace/extensions/claude-code/index.ts:80-83` says subagent permission mode defaults to `auto`.
- `workspace/extensions/claude-code/index.ts:101-121` implements that default and also accepts `bypassPermissions`.
- `workspace/extensions/claude-code/index.ts:431-452` skips first-launch human approval for a subagent because parent spawn is treated as authorization.

This is inconsistent with the instructions presented to the external model:

- `src/cli/claude/channelHost.ts:300-313` says the CLI is pre-scoped to the context and native changes to projected repository bytes are discarded.

The projection is read-only, but native reads are not scoped to it. The child can read the user's home directory, SSH configuration and private keys, other workspaces, Vibestudio state, and its parent extension's environment. On the AES fallback credential store, the encryption key and ciphertext are both files under the same profile tree:

- `packages/credential-client/src/encryptedJsonStore.ts:70-103` reads or creates `keys/store.key`.
- `packages/credential-client/src/encryptedJsonStore.ts:105-159` uses that adjacent key for AES-GCM encryption and decryption.
- Credential records default beneath the same profile data root (`packages/credential-client/src/encryptedJsonStore.ts:348`).

The materialized scoped agent token is itself expected to be available to the linked process (`workspace/extensions/claude-code/index.ts:498-525`). The unexpected escalation is that the process also receives the trusted extension bearer and the rest of the host.

### Exploit preconditions

Any of the following is sufficient:

1. a headless Claude subagent is tasked with content containing a prompt injection;
2. the subagent reads a malicious repository file as part of an otherwise legitimate task;
3. the external model or CLI integration is compromised.

No filesystem write exploit is required. Native Bash can read host files, inspect the inherited environment, and use the shared network namespace. The extension bearer can also be replayed against the gateway as the reviewed extension principal.

### Impact

- disclosure and network exfiltration of host-readable secrets;
- decryption of fallback credential records when both store key and ciphertext are readable;
- impersonation of `@workspace-extensions/claude-code` over RPC;
- access to unrelated workspace or user files;
- violation of the documented property that agent userland does not receive credential material.

Read-only mounting limits destructive filesystem changes but does not materially bound confidentiality or principal authority.

### Remediation: one external-agent execution envelope

Introduce a host-owned `ExternalAgentLaunch`/`ContainedProcess` abstraction whose declaration includes:

- a minimal root filesystem assembled from reviewed runtime directories and the exact context projection, not `--ro-bind / /`;
- a dedicated sanitized Claude profile containing only the account/session material required by this launch;
- `--clearenv` semantics and an allowlist such as locale, `PATH`, the scoped agent credential, launch-profile coordinates, and explicit scratch variables;
- no extension RPC bearer, server service token, unrelated provider variable, or ambient home path;
- a network policy that permits the linked provider and the scoped Vibestudio bridge through attributed mediation rather than raw host networking;
- a new PID namespace and an owned process tree with bounded teardown.

The linked model still needs provider login, context reads, a scratch directory, and the Vibestudio bridge. Those should be explicit launch inputs, not recovered by exposing the host home and environment. If Claude's provider credential currently lives in the user's normal profile, project the minimum sanitized provider state or broker the provider connection; do not make the whole profile visible to preserve convenience.

Claude's `auto`/`manual` modes can remain useful UX policies, but they must not be treated as containment. Parent spawn authorizes the child relationship and task; it does not grant ambient authority held by the extension process.

## AR-2 — Direct RPC plus caller-erasing panel wrappers creates a terminal deputy

**Severity:** Critical\
**Confidence:** High\
**Status:** Verified compositional authorization bypass

### Evidence

Direct RPC relay is intentionally open among authenticated participants except for `extension.*` host-control methods:

- `src/server/rpcServer.ts:2753-2783` documents and implements the open relay.
- `src/server/rpcServer.httpRpc.test.ts:858-891` explicitly tests that unrelated panel and shell targets are relayable.

The transport does carry request context, but the base runtime drops it before invoking exposed handlers:

- `packages/runtime/src/setup/createBaseRuntime.ts:237-239` converts `rpc.expose(method, request => ...)` into `handler(...request.args)`.
- The terminal panel duplicates the same caller-erasing wrapper (`workspace/panels/terminal/TerminalApp.tsx:14-17`).

The terminal exposes sensitive methods directly:

- `workspace/panels/terminal/TerminalApp.tsx:639-683` exposes `terminal.listSessions`, `terminal.getScrollback`, `terminal.sendText`, `terminal.runCommand`, and metadata mutations.
- `workspace/panels/terminal/usePanelActions.ts:181-188` implements `sendText` as `shell.write`.

This is reachable through the ordinary panel-handle API rather than requiring a guessed transport identifier:

- panel metadata carries the live `runtimeEntityId` as `rpcTargetId` (`packages/runtime/src/shared/panelRuntime.ts:140-167`);
- a handle resolves that live target and relays arbitrary method calls to it (`packages/runtime/src/shared/handles.ts:62-81`, `packages/runtime/src/shared/handles.ts:110-120`);
- worker/eval hosted runtimes expose `listPanels` and `getPanelHandle` as normal runtime operations (`packages/runtime/src/shared/panelRuntime.ts:383-389`).

The shell extension does enforce session ownership, but it observes only its immediate caller:

- `workspace/extensions/shell/index.ts:627-629` authorizes a write against `currentOwner(ctx).callerId`.
- `workspace/extensions/shell/index.ts:649-681` similarly scopes list, session info, attach, and scrollback to that immediate owner.

For a relayed call, the immediate caller is the terminal panel. The terminal really does own the session, so the shell check succeeds. The original participant that invoked `terminal.sendText` has disappeared.

### Exploit preconditions

- a terminal panel and at least one shell session exist;
- another authenticated participant can list or obtain the terminal panel handle;
- the participant can make direct target RPC calls.

The participant calls `terminal.listSessions`, selects an ID, then calls `terminal.getScrollback` or `terminal.sendText`. A newline in `sendText` executes input in the existing interactive shell. This path does not exercise `shell.exec`'s “Run a command” approval.

### Impact

- command execution with the host user's terminal privileges without a new command approval;
- disclosure of terminal scrollback, which commonly contains source, credentials, URLs, and command output;
- alteration of terminal metadata and interactive state;
- cross-user risk in a multi-human workspace if session ownership is not tied through to the originating human.

This violates the repository's explicit rule that an intermediate service must not substitute its own principal.

### Remediation: receiver contracts and caller-preserving delegation

Do not solve this with a blacklist of `terminal.*` names. Direct peer RPC is a useful agentic primitive, and the same deputy pattern can recur in any panel that calls host services on behalf of its caller.

Instead:

1. Preserve `RpcRequestContext` in the public `expose` API. Handlers should receive a verified original caller/provenance object, not only spread arguments.
2. Give every exposed receiver a declared contract such as:
   - public to authenticated participants;
   - same context;
   - same owner/user;
   - parent/child relationship;
   - explicit capability/delegation handle.
3. When a panel invokes a host service for a remote caller, propagate the original caller as an authenticated delegation chain. The receiver evaluates both the reviewed panel code and the original caller.
4. Model interactive terminal control as a scoped `TerminalSessionHandle` capability. The terminal UI receives it automatically for sessions it creates; a peer receives it only through an intentional share/delegation.

Normal terminal UI interaction remains prompt-free. Same-context automation can also remain smooth when a declared receiver contract covers it. Only a widening from “this terminal/owner” to another participant should require a grant or prompt.

## AR-3 — Shell approval is not the executed intent

**Severity:** High\
**Confidence:** High\
**Status:** Remediated in this working tree (2026-07-27)

### Evidence: shell script construction

For `shell:true`, execution is:

```ts
spawn("/bin/sh", ["-c", [req.command, ...req.args].join(" ")], ...)
```

at `workspace/extensions/shell/exec.ts:24-35`.

The approval renders every field as a separately quoted shell argument:

- `workspace/extensions/shell/approvals.ts:31-52` computes the displayed command with `argv.map(shellQuoteForDisplay).join(" ")`.
- `workspace/extensions/shell/approvals.ts:109-112` single-quotes metacharacter-containing values.

Therefore this request:

```json
{
  "command": "printf",
  "args": ["safe; touch /tmp/unapproved"],
  "shell": true
}
```

is presented approximately as:

```sh
printf 'safe; touch /tmp/unapproved'
```

but executes:

```sh
printf safe; touch /tmp/unapproved
```

The approval subject digest covers the structured fields (`workspace/extensions/shell/approvals.ts:25-42`), but the fields are transformed differently for display and execution, so hashing them does not restore exactness.

### Evidence: hidden environment semantics

The caller may supply arbitrary environment entries except a narrow blocked regex:

- `workspace/extensions/shell/index.ts:25-56` builds a minimal base environment, then applies caller entries unless they match `LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `SHELL`, or `DYLD_*`.
- `workspace/extensions/shell/types.ts:3-33` admits an `env` map.
- The approval contains command, args, cwd, and shell mode but not environment (`workspace/extensions/shell/approvals.ts:31-52`).

For example, an unshown `PATH` override can make an approved `git status` execute a workspace-controlled `git` binary. Other interpreter-specific variables can change startup or module loading. The issue is not that environment customization exists; it is that it changes the approved operation without being part of the decision.

### Exploit preconditions

- a caller can request `shell.exec`;
- the user allows the materially misleading approval;
- for the environment variant, attacker-controlled executable/config content is reachable through an override.

### Impact

Arbitrary additional commands can execute within the already selected cwd and host shell environment, while the user is shown a different operation. This is a direct approval-integrity bypass.

### Remediation: canonical executable intent

Replace the ambiguous shape with a tagged union:

```ts
type ExecIntent =
  | { kind: "argv"; executable: string; argv: string[]; environment: CanonicalEnvDelta }
  | { kind: "script"; interpreter: "/bin/sh"; script: string; environment: CanonicalEnvDelta };
```

- `argv` mode executes directly with no shell.
- `script` mode displays, hashes, audits, and passes the exact same script bytes to `sh -c`.
- One canonical serializer produces both the approval preview and the execution input.
- Resolve the executable under the approved environment before prompting, and bind the resolved executable identity when practical.
- Treat environment changes as part of the subject digest. Keep ordinary locale/terminal defaults collapsed, but show behavior-affecting overrides such as `PATH`, loader paths, interpreter startup, config, and credential variables.

This preserves shell expressiveness and agentic DX. It improves the dialog because users review one truthful script instead of a pseudo-argv whose semantics change later.

## AR-4 — Redirects escape the authorized URL boundary

**Severity:** High\
**Confidence:** High\
**Status:** Verified in buffered fetch, streamed fetch, and Git HTTP paths

### Evidence

`executeAuthorizedRequest` authorizes the initial URL before calling an execution callback:

- `src/server/services/egressProxy.ts:898-939` computes mission behavior and calls `authorizeRequest`.
- `src/server/services/egressProxy.ts:1078-1163` resolves a credential binding or explicit credential against that URL.
- Raw egress approval is keyed to the initial origin (`src/server/services/egressProxy.ts:1166-1230`).

Automatic redirects are disabled only when `missionRequiresManualRedirects` returns true:

- `src/server/services/egressProxy.ts:876-895` delegates that decision to mission exposure.
- `src/server/services/missionRegistry.ts:835-870` returns true only for a `declared-origins` mission. Interactive sessions and unrestricted missions return false.

The host fetch paths use `redirect: "follow"` when that flag is false:

- buffered `proxyFetch`: `src/server/services/egressProxy.ts:395-457`;
- streamed `proxyFetch`: `src/server/services/egressProxy.ts:483-611`;
- Git HTTP: `src/server/services/egressProxy.ts:633-670`.

The final URL is reported and marked as external ingestion, but only after the request has already been followed (`src/server/services/egressProxy.ts:438-454`, `src/server/services/egressProxy.ts:533-541`).

### Exploit preconditions

- an agent/runtime has authority for an initial origin or URL-bound credential audience;
- the initial server returns a redirect controlled by an attacker or compromised dependency;
- the caller is interactive or has unrestricted mission network exposure (the common paths where automatic following remains enabled).

### Impact

- an approved public origin can redirect to loopback, RFC1918, or cloud-metadata endpoints, bypassing origin-specific raw-egress approval;
- a URL-bound credential request can redirect within the same origin but outside its approved path prefix while retaining same-origin authorization headers;
- cross-origin redirects can reach unauthenticated internal services even where Fetch strips sensitive headers;
- audit and ingestion may report the final destination, but reporting does not prevent the unauthorized request.

The standard Fetch behavior of removing some sensitive headers on cross-origin redirects is not a sufficient authorization boundary. It does not protect same-origin path audiences or raw/internal-network authority.

### Remediation: an authorized redirect fetcher

Create one `AuthorizedRedirectFetcher` used by buffered, streamed, Git, and future proxy paths:

1. always issue each upstream request with `redirect: "manual"`;
2. resolve and validate `Location`, protocol, and a small hop limit;
3. rerun mission exposure, internal-request checks, raw-egress approval, and credential audience matching for every hop;
4. rebuild headers from the destination's authorization result; never carry sensitive headers merely because Fetch would;
5. implement standard 301/302/303/307/308 method/body behavior centrally;
6. audit every hop or record a structured redirect chain.

This need not create prompt fatigue. A same-origin redirect that stays inside the same credential binding or an already granted raw-egress origin should proceed silently. A prompt is needed only when the redirect widens authority.

## AR-5 — Shell exec timeout does not bound the process lifecycle

**Severity:** Medium\
**Confidence:** High\
**Status:** Remediated in this working tree (2026-07-27)

### Evidence

`workspace/extensions/shell/exec.ts:37-43` sends SIGTERM at the timeout and then does:

```ts
if (!child.killed) child.kill("SIGKILL");
```

`ChildProcess.killed` means a signal was successfully sent; it does not mean the process exited. It will normally be true after the preceding SIGTERM, so the SIGKILL fallback is skipped for a non-cooperative process.

The exec child is not placed in its own process group (`workspace/extensions/shell/exec.ts:24-35`), and only the direct PID is signaled. Descendants can survive. The returned promise resolves only on `close` (`workspace/extensions/shell/exec.ts:56-65`), so a process that remains alive, or descendants retaining inherited pipes, can keep the effect unsettled beyond `timeoutMs`.

### Exploit preconditions

The command has already received shell approval. It ignores/handles SIGTERM or spawns background descendants.

### Impact

- persistent writers, listeners, miners, or resource consumers after the advertised timeout;
- a wedged agent effect waiting indefinitely for `close`;
- teardown that appears successful while descendants survive.

This is primarily a lifecycle-integrity and availability issue, not an initial authorization bypass.

### Remediation: shared owned process trees

Use one host `OwnedProcessTree` abstraction for shell exec, PTYs, external agents, and other native helpers:

- create a POSIX process group (or Windows Job Object);
- signal the whole group;
- wait on an exit promise/state, not `child.killed`;
- after a bounded grace period, SIGKILL the whole group;
- close or drain stdio deterministically;
- return a bounded terminal result even when cleanup required escalation.

The repository already uses process-group ownership for workspace child trees (`src/server/hubServer.ts:2222-2245`); the same semantic contract should be reused rather than reimplemented per feature.

## Hardening opportunities

These are not counted as verified privilege-escalation findings.

### H-1 — Egress audit writes fail open

`src/server/services/egressProxy.ts:2155-2160` catches every audit append failure so the response remains reliable. Authorization still occurs, so this is not an authority bypass by itself. It does mean sensitive network and credential use can become invisible during disk/database failure.

A UX-preserving design is a local durable audit outbox: commit a compact receipt before releasing the final result, drain asynchronously, expose unhealthy/backlog state, and apply an explicit policy if the outbox itself is unavailable. This avoids turning a transient remote request into a random user-facing failure while making “audit complete” a truthful property.

### H-2 — Linked-Claude trajectory mirroring retains secret-shaped tool inputs

The bridge stores unabridged native tool input and up to 500 characters of tool output:

- `src/cli/claude/hookSocket.ts:85-98` bounds output summaries;
- `src/cli/claude/hookSocket.ts:107-185` explicitly retains full structured tool input.

This is useful for agentic debugging and consistent with the system's trajectory model, but Bash commands, Write payloads, URLs, and provider errors can contain secrets. The system-test documentation correctly treats full trajectories as sensitive.

Add a shared field-aware trajectory redactor and retention classification. Preserve debugging through locally encrypted full-fidelity evidence or explicit opt-in capture, while the normal conversation trajectory receives redacted values plus hashes/size/type. Do not simply remove tool observability.

### H-3 — Filesystem path validation is path-based rather than descriptor-based

The filesystem service performs strong lexical, realpath, per-component symlink checks (`packages/shared/src/fsService.ts:300-345`). A local peer able to mutate the host tree concurrently could theoretically race validation and the subsequent path operation. Agent callers cannot normally construct an escaping symlink through this API: symlink creation proves the target remains inside the context and managed source symlinks are denied (`packages/shared/src/fsService.ts:2671-2708`).

This is defense in depth against a local same-UID race, not a demonstrated agent escape. A future Linux backend can move sensitive operations to dirfd-relative/openat2-style resolution, but that should not block the current semantic API.

## Verified controls and non-findings

### Native EvalDO confinement

The reviewed eval path does not expose host `process`, raw filesystem, or ambient network primitives:

- `packages/shared/src/evalConfinement.ts:1-45` declares an explicit guest-global allowlist and excludes host authority.
- `src/server/internalDOs/evalNodeCompat.ts:40-133` implements `node:fs` through the owner-scoped runtime filesystem and omits `node:child_process`.
- `src/server/internalDOs/evalDO.ts:1490-1690` builds explicit bindings and reviewed import maps.
- `src/server/internalDOs/evalDO.ts:2138-2151` uses an owner-scoped, relative-only gateway bearer.
- `src/server/internalDOs/evalDO.ts:2240-2256` keeps `fetch` private to the reviewed CDP provider rather than publishing it to authored eval code.

Focused confinement and Node-compat tests passed in this review.

### Filesystem context and semantic mutation controls

- Agent filesystem scope comes from a verified live binding, not a caller-supplied context (`packages/shared/src/fsService.ts:1521-1543`).
- Extension invocations inherit their chained caller's context; unchained extension host filesystem access requires an explicit allowlist capability (`packages/shared/src/fsService.ts:1544-1586`).
- Open file handles are caller-bound (`packages/shared/src/fsService.ts:1650-1655`).
- Managed source mutations require resolved content integrity and an exact causal tool invocation (`packages/shared/src/fsService.ts:1752-1803`).

These controls make a simple `../` or symlink escape through the portable filesystem a non-finding.

### Live scoped agent credentials

- Credential redemption resolves the live entity, active session binding, and current owner on every redemption (`src/server/services/authService.ts:133-160`).
- Binding facts are derived from the entity graph, not embedded claims (`src/server/hostCore/auth/agentEntity.ts:4-29`).
- Claude launch rotation revokes the previous credential, and release revokes the current credential and removes the materialized profile (`workspace/extensions/claude-code/index.ts:490-560`, `workspace/extensions/claude-code/index.ts:580-609`).
- Materialized profile directories/files use 0700/0600 and unique materialization IDs (`packages/shared/src/claudeLaunchProfile.ts:90-136`).

Those controls limit the intended agent token. AR-1 exists because the same process receives a second, more privileged extension token and broad host visibility.

### Model credentials and attributed egress

- The agent model SDK receives a sentinel rather than a real provider secret (`workspace/packages/agentic-do/src/model-fetch-proxy.ts:1-18`).
- Sentinel requests are matched to exact origin/path routes and rejected for unrelated destinations (`workspace/packages/agentic-do/src/model-fetch-proxy.ts:77-103`, `workspace/packages/agentic-do/src/model-fetch-proxy.ts:220-260`).
- Dynamic workers stamp a non-forgeable caller identity into outbound traffic (`src/server/workerdPrograms/workerHost.ts:23-35`, `src/server/workerdPrograms/workerHost.ts:68-85`).
- Workerd routes DO and dynamic-worker global outbound through the egress proxy (`src/server/workerdManager.ts:1756-1792`, `src/server/workerdManager.ts:1821-1848`).
- The shared proxy listener validates its secret and resolves a live verified caller (`src/server/services/egressProxy.ts:230-295`).

The old concern that worker egress was unwired is no longer current. AR-4 is narrower: a host `fetch()` inside that otherwise mediated boundary can follow subsequent URLs without reauthorization.

### Prompt-injection provenance

- Web search records every returned domain as external before exposing results (`workspace/packages/harness/src/web/index.ts:188-215`).
- Web fetch records external ingestion on cached and fresh paths (`workspace/packages/harness/src/web/index.ts:219-303`).
- Agent tools wire ingestion to the host context-integrity service (`workspace/packages/agentic-do/src/agent-worker-base.ts:338-355`).
- Agent approval level is explicitly only a UX convenience; sensitive effects remain host-gated (`workspace/packages/agentic-do/src/agent-vessel.ts:6399-6403`).

This is the right synthesis for prompt injection: do not attempt to classify natural-language instructions as safe; bind the effects they can cause to durable content provenance and receiver authority.

### System-test artifact defaults

- Default artifact directories are created 0700 and files 0600 (`src/cli/systemTestStore.ts:42-50`, `src/cli/systemTestStore.ts:93-107`).
- Atomic replacement uses an exclusive 0600 temporary file, rename, chmod, and fsync (`src/atomicFile.ts:23-47`).
- Documentation warns that full trajectories can contain credentials, user data, source, and tool payloads (`workspace/skills/system-testing/references/diagnostics-and-artifacts.md:126-136`).

The default path is appropriately restrictive. Custom `--out-dir` remains an operator-selected disclosure boundary and should retain the same warning.

## Validation performed

The original evidence-gathering pass was read-only and covered the production call chains
listed above. The remediation update below describes the subsequent product-code changes.

Focused tests:

- 139 of 140 tests passed across `claudeReadOnlyLaunch`, Claude extension launch, shell extension, RPC HTTP relay, and egress proxy suites.
- The remaining test was the live bubblewrap EROFS assertion in `packages/shared/src/claudeReadOnlyLaunch.test.ts`. Bubblewrap failed earlier with `setting up uid map: Permission denied` in this review environment. The launch fails closed there; the environment could not exercise its intended EROFS assertion. This does not affect the source-level AR-1 finding that the declared mount is `/`.
- 11 of 11 focused eval-confinement, eval Node-compat, and system-test command tests passed.

No exploit payload was executed against a live user terminal, credential store, or external network.

### Remediation validation update — 2026-07-27

AR-3 and AR-5 were subsequently repaired in the same working tree:

- `shell.exec` now accepts a strict tagged `intent`: direct `argv` execution or one exact
  `/bin/sh` script. The removed `command` / `args` / `shell` request shape is rejected rather
  than translated.
- The resolved cwd and the captured, exact effective environment are part of the approval
  subject. Caller-authored environment overrides are shown, while ordinary inherited
  locale/terminal defaults remain collapsed to avoid prompt noise.
- The complete execution plan is host-sealed for the lifetime of the prompt. Trusted desktop
  and mobile approval surfaces can lazily inspect its exact command/script, cwd, environment,
  stdin, timeout, and output bounds; execution uses the same sealed bytes returned by the host.
- Reusable grants bind to the complete plan review digest. Sealed and unsealed requests cannot
  reuse one another's decisions.
- Pending projections contain only sealed-detail references. Retained content is limited to
  15 MiB per caller and 60 MiB aggregate, preserving one maximum-sized legitimate plan per
  caller while preventing unique pending subjects from pinning unbounded heap. Accounting is
  released through the queue's common removal path on settlement, dismissal, abort, and caller
  cancellation.
- Direct argv values are never reconstructed as shell source.
- Timed POSIX execution owns a separate process group and applies bounded TERM/KILL teardown
  to the group. Windows execution uses bounded `taskkill /T /F` tree teardown. Cleanup no
  longer treats `ChildProcess.killed` as evidence of exit.

Validation after remediation:

- 140 focused approval and shell tests passed, including exact argv metacharacters, exact
  script semantics, independent cwd/environment subject binding, rejection of the legacy
  shape, complete-plan inspection, grant digest separation, per-caller and aggregate retained
  byte limits, lifecycle quota release, and a TERM-resistant descendant that must not survive
  timeout.
- All three workspace TypeScript configurations passed.

## Remediation order

1. **Repair receiver authority propagation (AR-2).** Treat this as a platform seam, then migrate terminal exposure to a caller-aware contract. Avoid a terminal-only method denylist.
2. **Centralize per-hop redirects (AR-4).** Reuse one implementation for fetch, stream, Git, and provider traffic.
3. **Containerize linked external agents (AR-1) when this accepted risk is revisited.** Environment filtering or a read-only host mount must not be presented as equivalent containment.
4. Preserve the completed canonical shell-intent and owned-process-tree corrections (AR-3 and AR-5).
5. Add durable audit receipts and trajectory redaction as hardening after the authority defects are closed.

The first four changes should be tested with negative integration cases that assert both sides of the UX contract: ordinary same-authority actions remain silent, while boundary widening is denied or prompts exactly once.

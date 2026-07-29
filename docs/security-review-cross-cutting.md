# Vibestudio security review: cross-cutting trust boundaries

**Review date:** 2026-07-27\
**Reviewed revision:** `9925c8d52aa90dd84df838de57382f7504d3dbf7` (`main`)\
**Scope:** authenticated RPC routing, receiver authority, resource containment,
security diagnostics, and the relationship between the host capability model and
runtime-to-runtime calls.

This report is one part of the July 2026 review. It should be read with:

- `docs/security-review-server.md`
- `docs/security-review-agent-runtime.md`
- `docs/security-review-client-supply-chain.md`

### Post-review remediation status

XCT-02 and XCT-03 are resolved in the working tree. Ordinary HTTP RPC authenticates
before reading its body. Local RPC credentials are resolved through a typed,
empty-body HTTP admission exchange with bounded async work and outstanding state; a
15-second, one-use grant is then consumed and revalidated before WebSocket receiver
allocation. CDP/inspector credentials are likewise validated before upgrade. Every
`ws` major in both lockfiles resolves to a patched release. XCT-01 (receiver
authority/original-caller propagation) and XCT-04 (external error redaction) remain
open.

The review treats the intended architecture as a product requirement: tokens identify
callers, grants authorize effects, trusted intermediaries retain the original
principal, and agents use the same boundaries as other userland. Recommendations are
therefore aimed at completing those abstractions rather than adding prompts or
one-off blocks.

## Executive result

The host service boundary is substantially stronger than the April 2026 audit
described. Service definitions are default-deny, the dispatcher performs authority
evaluation before invoking handlers, code/session identity is kept separate, and
focused authority tests pass.

One separate transport surface does not yet share that model: direct RPC between
runtime participants is intentionally open after authentication. Receiver handlers do
receive verified caller identity, but common panel wrappers erase it and exposed panel
methods have no sealed receiver contract. In the terminal panel this composes into a
high-confidence host command-injection path: any authenticated participant that can
address a terminal panel can enumerate its sessions, inject text (including a command
and newline), and read scrollback. The shell extension sees the terminal panel—not the
original participant—as its caller, so its session-ownership check succeeds.

That is not best repaired with a terminal method blacklist. Direct runtime RPC needs
the same declared, version-bound receiver authority used by host services and Durable
Objects.

## Threat model used

The review assumes:

- workspace panel and worker code can be agent-authored and may be compromised;
- authentication of a runtime does not make its code trusted;
- a malicious runtime may know or discover other panel/runtime identifiers;
- a terminal process runs with the desktop/server user's OS authority;
- a paired device and an authenticated workspace member are meaningful identities,
  but neither implicitly authorizes every runtime effect;
- local denial of service still matters because it can destroy unsaved work and
  interrupt agent execution.

The review does not assume an attacker has already stolen the admin token, modified
the trusted host checkout, or obtained arbitrary OS code execution.

## Findings

### XCT-01 — Critical — Open participant relay plus caller-erasing receivers permits terminal command injection

**Status:** verified by code path and existing routing tests\
**Confidence:** high\
**Class:** authorization bypass / confused deputy / host code execution

#### Evidence

The RPC server explicitly makes relay open between authenticated participants. Its
only built-in cross-runtime restriction is for `extension.*` host-control methods;
otherwise an optional policy is consulted and absence means allow:

- `src/server/rpcServer.ts:2753-2783`

Existing tests lock this behavior in for unrelated panels and shell targets:

- `src/server/rpcServer.httpRpc.test.ts:858-891`

The RPC library correctly delivers a verified inbound caller to every receiver:

- `packages/rpc/src/types.ts:216-252`
- `packages/rpc/src/types.ts:447-465`

But the common runtime convenience wrapper discards the entire request context,
including `caller` and `origin`, and forwards only positional arguments:

- `packages/runtime/src/setup/createBaseRuntime.ts:237-239`

The terminal panel repeats this caller-erasing wrapper:

- `workspace/panels/terminal/TerminalApp.tsx:14-17`

It then exposes direct methods for session enumeration, terminal input, scrollback,
and command execution without a receiver policy:

- `workspace/panels/terminal/TerminalApp.tsx:639-683`

`terminal.sendText` delegates to `shell.write` under the terminal panel's own runtime
identity:

- `workspace/panels/terminal/usePanelActions.ts:181-188`

The trusted shell extension correctly checks that the _immediate extension caller_
owns the session, but at this point that caller is the deputy terminal panel. The
original participant no longer participates in the decision:

- `workspace/extensions/shell/index.ts:83-87`
- `workspace/extensions/shell/index.ts:627-629`

The result is a complete path:

1. Attacker-controlled authenticated panel, worker, DO, or agent runtime addresses a
   terminal panel.
2. It calls `terminal.listSessions`.
3. It calls `terminal.sendText` with a returned session id and arbitrary text ending
   in a newline.
4. The terminal panel calls the shell extension as itself.
5. The shell extension sees the legitimate session owner and writes to the PTY.

No new command approval is reached on the `sendText` path. `terminal.getScrollback`
also exposes the terminal's output, so the same path provides confidentiality loss as
well as command execution.

The generic panel agent API has the same structural bypass. The host exposes a
policy-bearing `panelTree.callAgent` operation:

- `packages/service-schemas/src/panelTree.ts:403-410`
- `src/server/services/panelTreeService.ts:137-150`

Yet panels also directly expose `_agent.snapshot`, `_agent.tree`, `_agent.state`,
`_agent.routes`, and `_agent.setMode`:

- `packages/runtime/src/panel/agentApi.ts:65-72`

Open direct relay can therefore bypass the host's panel relationship/resource
evaluation and read rendered text or registered panel state directly.

#### Preconditions

- The attacker controls any authenticated workspace runtime.
- It can address the terminal panel. Runtime ids are ordinary routing identities and
  the transport deliberately permits unrelated targets.
- At least one terminal session exists for the no-prompt `sendText` path.

#### Impact

- Arbitrary command execution as the Vibestudio host user.
- Read access to terminal scrollback, which may contain source, command output, paths,
  or secrets printed by other tools.
- Cross-panel rendered-text and state disclosure through the generic agent API.
- Mutation of another panel's test/data mode.

#### UX and agentic-DX preserving remediation

Make direct runtime RPC a first-class receiver-authority surface:

1. Replace string-only `rpc.expose(method, handler)` for cross-runtime endpoints with
   a sealed receiver contract tied to the exact receiver build. The contract should
   declare principals, semantic capability/effect, tier, sensitivity, relationship
   requirements, and resource derivation just as host and DO receivers do.
2. Evaluate that contract before invoking the handler, using the gateway-stamped
   original caller. Authentication remains transport admission, not authorization.
3. Remove or deprecate caller-erasing wrappers. Ergonomic helpers may still spread
   arguments, but handlers that cause effects must retain an authenticated invocation
   context by construction.
4. Express terminal automation as a coherent capability such as control of one
   terminal panel/session. Local keyboard input remains a local UI action and needs no
   new prompt. Cross-runtime automation uses standing task/session/version grants or
   fresh approval according to the existing authority vocabulary.
5. Route headless system tests through their existing host-attested test policy so
   testing remains smooth without creating a production bypass.
6. Keep panel handles and agent APIs. Bind them to panel ownership/ancestry and exact
   read/control capabilities rather than removing the functionality.

This preserves today's powerful agentic workflows while making the original caller
part of every effect decision. A transport-level deny-list for terminal method names
would leave every other receiver vulnerable and would be the wrong abstraction.

#### Regression tests

- An unrelated authenticated worker cannot call an undeclared panel receiver method.
- A caller cannot invoke `terminal.listSessions`, `terminal.getScrollback`, or
  `terminal.sendText` without the exact receiver capability/relationship.
- An authorized agent/test session can control the intended terminal without an
  extra prompt on every keystroke.
- The terminal panel cannot launder the originating principal when it calls the shell
  extension.
- Direct `_agent.state` and `_agent.snapshot` access enforces the same relationship
  contract as `panelTree.callAgent`.

### XCT-02 — High — The directly used WebSocket implementation was vulnerable to pre-auth memory exhaustion (resolved)

**Status:** resolved in the working tree\
**Confidence:** high\
**Class:** denial of service / vulnerable dependency

#### Evidence at the reviewed revision

`pnpm audit --prod --json` reported
[GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) for `ws`.
The installed production graph resolved `ws` to `8.19.0`; versions before `8.21.0`
are vulnerable to memory exhaustion from many tiny fragments and data chunks.

Vibestudio constructs multiple `WebSocketServer` instances without an explicit
`maxPayload`, including the primary RPC server:

- `src/server/rpcServer.ts:1123-1132`
- `src/server/gateway.ts:507`
- `src/server/panelHttpServer.ts:293`

The primary server performs authentication only after the WebSocket upgrade and after
receiving the first application message:

- `src/server/rpcServer.ts:1140-1169`

The dependency issue is below that authentication layer, so token checks and the
10-second auth timeout do not mitigate fragment-wrapper allocation. The gateway is
loopback-bound in the normal product architecture, reducing network exposure, but
untrusted panel code and other local processes remain relevant attackers. A remote
transport that terminates into the same WebSocket implementation must also be treated
as exposed until proven otherwise.

#### Recommended remediation

- Upgrade all production `ws` resolutions to `8.21.0` or newer and lock the patched
  floor so transitive copies do not drift back.
- Set an explicit, product-appropriate `maxPayload` on every server as defense in
  depth. Control RPC frames should be small; bulk data already has streaming/CAS
  paths.
- Add a dependency-policy test for security floors of directly exposed protocol
  libraries.

This has no UX cost. Smaller control-plane frames improve failure diagnostics by
directing large payloads to the streaming or content-addressed path they should use.

#### Implemented remediation

Both lockfiles now force production `ws` 6/7/8 lines to patched releases, including
`ws@8.21.1`. Gateway RPC no longer upgrades through an unbounded independent
`WebSocketServer`; `RpcServer` owns one 16 MiB control-plane receiver. CDP and inspector
receivers retain a deliberate 256 MiB post-admission ceiling for screenshots and
debugger payloads.

Local RPC clients first send an empty-body `POST /rpc/ws-admission` request with their
credential in Authorization plus a percent-encoded client label and enumerated platform in
bounded headers. Browser OPTIONS/POST is guarded by the same WebSocket Origin allow-list.
The server reserves capacity before asynchronous work, permitting at most 32 concurrent
credential resolutions and 1,024 outstanding 15-second, one-use grants. Typed failures
distinguish invalid/admin credentials, malformed requests, saturation, and server
unavailability, with truthful retry timing before a socket is opened.

The upgrade accepts only the admission grant, atomically consumes it, and revalidates its
token/grant principal and incarnation before receiver allocation. No direct-token/bootstrap
upgrade path remains. The first frame constant-time matches the grant and exactly matches
the admitted label/platform while retaining RPC contract negotiation.

A 30-second process-keyed HMAC retry record is retained only when a fresh one-time
pairing credential was successfully redeemed. An exact-metadata retry rotates the sole
outstanding grant, preserving lost-response/auth-result UX without creating a parallel
authentication path; returning refresh/token credentials are not cached, and revocation
invalidates both grants and retry records. Clients honor typed retry timing, obtain a fresh
grant after pre-open failure, reject refresh that returns the same rejected token, and
retain stale-token refresh/cold-recovery behavior.

### XCT-03 — Medium — HTTP RPC authenticated after buffering a 256 MiB body (resolved)

**Status:** resolved in the working tree\
**Confidence:** high\
**Class:** resource exhaustion

#### Evidence at the reviewed revision

The default unary HTTP RPC body limit is 256 MiB:

- `src/server/rpcServer/httpRpcHandler.ts:14`
- `src/server/rpcServer/httpRpcHandler.ts:45-50`

The handler buffers all chunks, concatenates them, and parses JSON before it
authenticates the request:

- `src/server/rpcServer/httpRpcHandler.ts:77-113`

That permits an unauthenticated loopback process to make the host hold a large body,
and an authenticated malicious runtime can issue concurrent requests. The limit is
per request, with no visible per-caller/global memory budget. The HTTP streaming path
already caps request bodies at 16 MiB, demonstrating that large data has a more
appropriate transport:

- `src/server/rpcServer/streamingRelay.ts:36`
- `src/server/rpcServer/streamingRelay.ts:132`

#### Remediation

1. Authenticate headers before reading the body.
2. Reduce the unary JSON default to a control-plane size based on measured legitimate
   requests.
3. Add global and per-caller in-flight byte/request budgets.
4. Return a structured error pointing callers to streaming/blob/CAS APIs for large
   content.

This improves agentic DX: agents get an actionable transport choice instead of being
allowed to create an enormous, fragile JSON request.

#### Implemented remediation

Unary HTTP RPC now validates the bearer and live caller before consuming the request
iterator. Invalid credentials are rejected without reading the body. The existing
authenticated 256 MiB request ceiling and the streaming/bulk lanes are preserved, so
the fix changes admission ordering rather than silently shrinking legitimate workloads.

### XCT-04 — Low — RPC errors return host stack traces to every authenticated caller

**Status:** verified hardening issue\
**Confidence:** high\
**Class:** information disclosure

The HTTP RPC error envelope includes `error.stack` whenever the thrown value is an
`Error`:

- `src/server/rpcServer/httpRpcHandler.ts:187-202`

Stacks can reveal host filesystem paths, package layout, internal method names, and
implementation details to sandboxed userland. The detail is valuable during
development, so simply deleting it would harm agentic debugging.

#### Remediation

Return the stable structured error kind/code/data plus an opaque diagnostic id across
the userland boundary. Store the full stack in the existing trusted diagnostics/log
surface, and allow authorized developer tools and system-test inspection to resolve
the diagnostic id. Development-only local shells may opt into inline stacks, but the
authorization decision must come from trusted configuration rather than caller input.

## Strong controls verified

The review rechecked several areas that were critical in the April audit and found
material, coherent remediation:

- Electron shell and panel views use `nodeIntegration: false`,
  `contextIsolation: true`, and `sandbox: true`
  (`src/main/viewManager.ts:293-303`, `src/main/viewManager.ts:553-576`).
- The service dispatcher refuses undeclared methods and performs authority evaluation
  before handler invocation (`packages/shared/src/serviceDispatcher.ts:832-901`).
- Promptable methods without reviewed capabilities and methods without authority
  declarations fail registration
  (`packages/shared/src/serviceDispatcher.ts:760-807`).
- The URL-bound egress proxy is instantiated and wired through the dispatcher-owned
  host-effect authorizer (`src/server/index.ts:820-881`) and workerd receives only
  attributed/shared proxy ports (`src/server/bootstrap/workerd.ts:160-219`).
- Credential records use encrypted envelopes and restrictive file modes
  (`packages/credential-client/src/encryptedJsonStore.ts:162-193`).
- Admin-token comparison is default-deny and constant-time
  (`packages/shared/src/tokenManager.ts:15-33`, `packages/shared/src/tokenManager.ts:185-205`).

These controls should be preserved. The highest-value remediation is to extend their
shared vocabulary to direct runtime receivers, not create a competing security layer.

## Validation performed

The following focused checks passed on the reviewed revision:

- `pnpm check:unit-authority`
- 139 focused tests covering token handling, authorization evaluation, service
  dispatch, server and Electron authority matrices, encrypted credential storage,
  egress, WebSocket origin checks, and HTTP RPC

Post-review typed-admission validation passed 340 tests across 15 focused host files,
host/workerd typechecking, workspace desktop/integration/mobile typechecking, and scoped
ESLint with no errors or warnings.

The production dependency audit did not pass: it reported 91 advisories before
reachability triage (8 low, 49 moderate, 32 high, 2 critical). See the client and
supply-chain report for the reachable subset and remediation order.

## Recommended order

1. Treat XCT-01 as the release-blocking architectural issue. Design and migrate one
   receiver-contract path; do not add a terminal-only transport exception.
2. Preserve the patched dependency floors and typed-ingress regression properties as
   transport code evolves.
3. Preserve detailed diagnostics behind an authorized lookup instead of returning
   raw stacks to userland.

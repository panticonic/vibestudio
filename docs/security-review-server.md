# Server, identity, and network security review

**Review date:** 2026-07-27\
**Reviewed revision:** `9925c8d5` (`main`)\
**Scope:** Node gateway and RPC server, identity/session admission, route dispatch, workerd relay, credential egress, webhook ingress, public callback relay, local persistence, and multi-instance boundaries.

### Post-review remediation status

The working tree now resolves SV-01 and SV-07. HTTP RPC authenticates before reading its body.
CDP/inspector credentials are validated synchronously during the HTTP upgrade, before `ws`
allocates its message receiver. Local RPC instead uses a typed, empty-body HTTP admission request
before upgrade, guarded by the same WebSocket Origin policy for browser requests. Credential
resolution—including asynchronous pairing/device lookup—is bounded to 32 concurrent resolutions
and 1,024 outstanding 15-second, one-use grants. Upgrade atomically consumes the grant and
revalidates its token/grant principal and incarnation before receiver allocation; the first RPC
frame then exactly binds the grant and admitted client metadata. A narrowly scoped 30-second
process-keyed HMAC retry record exists only for a freshly redeemed one-time pairing credential,
rotating the prior grant so a lost HTTP response or auth result does not break first-device UX.

CDP and inspector traffic retains its 256 MiB post-admission budget. The 64 KiB RPC
authentication-frame ceiling is a protocol-shape check after credential admission, not a claimed
anonymous transport-allocation boundary. Webhook subscriptions now persist an explicit body
budget. Existing behavior defaults to 1,500,000 bytes; relay subscriptions may select a smaller
ceiling, while direct subscriptions may explicitly opt into a larger operator-bounded ceiling.
Every `ws` 6/7/8 dependency line also resolves to a patched release.

The callback relay identity, redirect/DNS authorization, generic receiver authority, OAuth
endpoint binding, and JWKS-fetch findings remain open.

## Executive assessment

The backend has a substantially better baseline than its attack-surface size might suggest. The primary gateway is deliberately loopback-only, remote RPC uses the WebRTC transport, HTTP RPC derives caller identity from the bearer rather than the envelope, workspace membership is checked at HTTP admission and continuously on WebSocket traffic, Durable Object calls use exact method catalogs and host attestations, internal workerd routes require dispatch secrets, and stored credentials use authenticated encryption with strict path-component validation.

The material risks found were not missing cryptography or wholesale unauthenticated
administration. They sat at seams where two otherwise sound abstractions did not
compose. The first item below is now repaired; the others remain open:

1. transport authentication happened after potentially large allocations;
2. URL authorization happens once, while network resolution and redirects happen later;
3. the callback relay authenticates membership in a global server population, but treats a caller-chosen `serverId` as tenant identity;
4. Durable Object invocation has an exact authority contract, while ordinary runtime-to-runtime relay defaults to allow;
5. account-provider secrets are stored under a provider configuration, but some flows let the invoking runtime choose a different endpoint where those secrets are used.

Those seams can be repaired without making ordinary development hostile. The strongest design direction is to introduce four reusable concepts: a staged ingress budget, a resolved-and-authorized HTTP client, a per-install relay identity, and receiver-declared RPC contracts. They preserve large uploads, ordinary redirects, enterprise OAuth/OIDC, reconnects, and ergonomic `runtime.expose()` while making the actual security boundary explicit.

### Finding summary

| ID    | Severity | Confidence                         | Status                   | Finding                                                                                                  |
| ----- | -------- | ---------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| SV-01 | High     | High                               | Resolved in working tree | HTTP and WebSocket authentication previously followed large transport allocation                         |
| SV-02 | High     | High                               | Open                     | Egress grants are not re-evaluated across redirects or DNS resolution, enabling SSRF and audience escape |
| SV-03 | High     | High                               | Open                     | One global relay HMAC secret does not prove tenant identity; a caller can self-assert another `serverId` |
| SV-04 | Medium   | High on boundary, medium on impact | Open                     | Runtime relay authorization defaults to allow outside the Durable Object path                            |
| SV-05 | Medium   | High                               | Open                     | Configured OAuth client secrets can be used at caller-selected token endpoints                           |
| SV-06 | Medium   | High                               | Open                     | Webhook OIDC verification performs an unconstrained server-side JWKS fetch                               |
| SV-07 | Medium   | High                               | Resolved in working tree | The public direct-webhook route previously buffered an unbounded body before lookup or verification      |

Severity incorporates reachability at the reviewed revision. In particular, the HTTP
gateway bound to loopback and had no public TLS listener, so SV-01 and SV-07 were
primarily co-located-process or malicious-local-web-content availability risks rather
than unauthenticated internet RCE. Both are resolved in the working tree.

## Trust-boundary map

| Boundary                             | Intended trust decision                                          | Current implementation                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP/WS client → gateway             | Admit a concrete caller before expensive work                    | HTTP authenticates before reads; WS uses bounded typed admission and consumes a short-lived one-use grant before receiver allocation |
| Runtime → host service               | Method-specific principal and capability authority               | `ServiceDispatcher` and live caller checks are the canonical boundary                                                                |
| Runtime → Durable Object             | Exact target, method effect, active code identity, and authority | Build catalog plus direct authority attestation; fail-closed behavior is strong                                                      |
| Runtime → panel/shell/regular worker | Receiver permits caller and method                               | Transport permits authenticated participants by default                                                                              |
| Runtime → network                    | Reviewed URL audience and network exposure                       | Initial textual URL is authorized; redirect hops and resolved IPs are not                                                            |
| Home server → public relay           | Authenticate one installation/tenant                             | Global HMAC authenticates “a server”; `serverId` is self-asserted                                                                    |
| Workspace child → identity data      | Read only, with hub as sole writer                               | Shared SQLite database with `PRAGMA query_only = ON` in children                                                                     |
| Profile → developer instances        | Shared user-owned credentials, isolated runtime state            | Intentional profile-wide credential boundary, not adversarial instance isolation                                                     |

## Verified findings

### SV-01 — Authentication follows large transport allocation (resolved)

**Severity:** High\
**Confidence:** High\
**Affected property:** Availability\
**Preconditions:** The attacker can reach the loopback gateway, for example as another process under the OS account or web content that discovers the developer port. Remote unauthenticated internet reach is not present in the current architecture.

#### Evidence at the reviewed revision

- `src/server/rpcServer/httpRpcHandler.ts:14` sets the default ordinary RPC body ceiling to 256 MiB.
- `src/server/rpcServer/httpRpcHandler.ts:88-103` reads and retains every chunk up to that ceiling.
- JSON parsing and another full concatenation occur at `src/server/rpcServer/httpRpcHandler.ts:105-107`.
- Only after both operations does bearer admission run at `src/server/rpcServer/httpRpcHandler.ts:113-117`.
- In contrast, the streaming RPC path authenticates before reading its bounded envelope at `src/server/rpcServer/streamingRelay.ts:120-137`. This proves the safer ordering already fits the architecture.
- The gateway creates its WebSocket server without an explicit payload ceiling at `src/server/gateway.ts:505-507`, and the first frame is parsed before authentication at `src/server/rpcServer.ts:1145-1184`.
- The Origin gate permits literal `null` at `src/server/gateway.ts:680-696`. Sandboxed browser contexts commonly have a null origin, so this weakens the port-discovery mitigation.
- The gateway itself is loopback-only (`src/server/gateway.ts:501-503`, `src/server/gateway.ts:613-618`; also `src/server/index.ts:2668-2674`). This materially limits reach but does not protect against local web-to-loopback or co-located-process denial of service.

#### Impact at the reviewed revision

Concurrent unauthenticated HTTP requests can retain hundreds of MiB each and then force JSON decoding/concatenation. A large first WebSocket frame similarly consumes the underlying WS library's receive budget before the token is checked. The likely outcome is process memory exhaustion or severe garbage-collection pressure.

This is not an argument to reduce all RPC payloads to tiny values. Large developer and agent payloads are legitimate; they simply should not share the pre-auth control lane.

#### Recommended synthesis at the reviewed revision

Create one **staged ingress budget** used by HTTP, WS, WebRTC control frames, and public service routes:

1. authenticate headers or a small fixed-size auth frame first;
2. cap unauthenticated control material to a small value (for example 16–64 KiB);
3. after admission, apply per-principal concurrent-byte and request-count budgets;
4. move genuinely large values to the existing streaming/bulk lane with backpressure or bounded disk spooling.

For browser WebSockets, replace the blanket `null`-Origin allowance with a short-lived host-minted connection grant in the upgrade or first frame. Native/Node clients can retain the absent-Origin path. This preserves Electron, CDP, and large agent workflows without making an unauthenticated socket a large-memory capability.

Tests should assert that an invalid bearer is rejected before the request iterator is consumed and that an oversized first WS frame cannot allocate beyond the pre-auth budget.

#### Implemented remediation

- Ordinary HTTP RPC validates the bearer before consuming the request iterator while preserving
  the existing 256 MiB authenticated request ceiling and streaming RPC lane.
- Local clients present credentials to the typed, empty-body `POST /rpc/ws-admission`
  endpoint. The credential occupies only the bounded Authorization header; a percent-encoded
  client label and enumerated platform occupy bounded headers rather than a caller-controlled
  body. Browser OPTIONS/POST requests are guarded by the same Origin allow-list as WebSocket
  upgrade. Typed failures
  distinguish invalid credentials, admin credentials, malformed requests, saturation, and server
  unavailability; retryable responses carry truthful retry timing.
- Credential resolution is reserved before asynchronous work: at most 32 pairing/device-store
  resolutions may run concurrently, and at most 1,024 unconsumed grants may be outstanding.
- Successful admission returns a random 256-bit grant with a 15-second lifetime. It is consumed
  once and its token/grant principal plus current incarnation are revalidated before
  `handleUpgrade`; no direct-token/bootstrap upgrade path remains.
- A 30-second process-keyed HMAC replay record exists only after successful redemption of a fresh
  one-time pairing credential. An exact-metadata retry rotates and invalidates the earlier grant,
  preserving lost-response/auth-result recovery without making pairing credentials generally
  replayable. Returning refresh/token credentials are not cached. Caller revocation invalidates
  outstanding grants and retry records.
- CDP host-provider credentials and target-bound inspector/CDP grants use the same pre-upgrade
  admission primitive. Invalid or missing credentials receive an HTTP 401 without allocating a
  256 MiB WebSocket receiver.
- Headless-host diagnostics now describe the real upgrade lifecycle—credential acquisition,
  connecting, admitted, and retrying—rather than reporting a nonexistent post-upgrade auth send.
- The WebSocket protocol carries only the admission grant. The first `ws:auth` frame
  constant-time-binds that grant plus the admitted client label/platform, preventing a client
  from upgrading under one admission and presenting different session metadata.
- Clients honor typed saturation retry timing without refreshing credentials or opening a
  socket, retry pre-open failures with a fresh grant, and preserve existing refresh/cold-recovery
  behavior for genuinely stale credentials.
- The authenticated payload ceilings remain 16 MiB for RPC and 256 MiB for CDP/inspector, so
  large debugger messages and ordinary developer workflows do not lose capacity.

---

### SV-02 — URL authority is checked before redirects and DNS become concrete

**Severity:** High\
**Confidence:** High\
**Affected properties:** Confidentiality, integrity, availability\
**Preconditions:** An untrusted runtime has an egress or credential-use grant for an initial URL, and the approved endpoint redirects, is compromised, has an open redirect, or resolves to an unsafe address.

#### Evidence

- `src/server/services/egressProxy.ts:897-939` authorizes one initial `targetUrl`.
- Credential binding is selected against that initial URL at `src/server/services/egressProxy.ts:1078-1109` and `src/server/services/egressProxy.ts:1112-1129`.
- The actual fetch defaults to `redirect: "follow"` at:
  - `src/server/services/egressProxy.ts:422-437` for proxy fetch;
  - `src/server/services/egressProxy.ts:511-533` for streamed fetch;
  - `src/server/services/egressProxy.ts:639-655` for Git HTTP.
- Redirects become manual only when the optional mission exposure hook returns true (`src/server/services/egressProxy.ts:876-895`, `src/server/services/egressProxy.ts:927-939`). The test at `src/server/services/egressProxy.test.ts:1566-1591` explicitly covers this mission-only behavior.
- No redirect loop re-runs `authorizeRequest`; the fetch result's final URL is merely recorded after the fact (`src/server/services/egressProxy.ts:438-443`, `src/server/services/egressProxy.ts:535-539`).
- URL audience matching itself correctly checks scheme, host, and path prefix (`packages/credential-client/src/urlAudience.ts:118-140`). The escape happens after that correct check.
- CONNECT authorizes the textual hostname once and then calls `netConnect` directly at `src/server/services/egressProxy.ts:1645-1652` and `src/server/services/egressProxy.ts:1680-1682`. There is no resolved-address classification or pinning.
- Server-owned OAuth exchanges also use direct `fetch()` calls with default redirect behavior, including credential-bearing POSTs at `src/server/services/credentialConnectionCoordinator.ts:2460-2469`, `src/server/services/credentialConnectionCoordinator.ts:2519-2524`, and `src/server/services/credentialConnectionCoordinator.ts:2565-2576`.

#### Impact

An approved public endpoint can redirect to loopback, RFC 1918, link-local/cloud metadata, or another origin and the server follows it without another authority decision. The caller receives the response, creating an SSRF primitive.

Path-scoped grants can also be escaped by a redirect outside the approved path. Credential behavior varies by redirect type and origin, but credential-bearing 307/308 POSTs are especially sensitive because method and body can be retained. DNS rebinding is a related gap: policy reasons about a hostname, while the later connection uses whatever address DNS returns.

#### Recommended synthesis

Build one **resolved-and-authorized HTTP client** and require every server-side external fetch—including credential lifecycle and JWKS retrieval—to use it:

1. parse and normalize the requested URL;
2. authorize the semantic audience;
3. resolve all candidate addresses and classify loopback, private, link-local, multicast, and public ranges;
4. connect to a pinned approved address while retaining the correct TLS SNI/Host;
5. follow redirects in userland, re-running both URL-audience and resolved-network authorization on every hop;
6. apply time, response-size, redirect-count, and decompression budgets.

Redirects that remain inside the already-approved audience should remain invisible to users. Only a hop that expands the authority should require a new decision. Local-network access should be a first-class, accurately presented authority—not an ad hoc hostname denylist. That preserves ordinary API/Git/OAuth behavior and enterprise/private-network workflows.

---

### SV-03 — The callback relay has global membership authentication, not tenant authentication

**Severity:** High\
**Confidence:** High\
**Affected properties:** Confidentiality, integrity, availability\
**Preconditions:** The attacker obtains the shared relay secret (for example by controlling or compromising any installation to which it is distributed) and learns a target's random `serverId`. Intercepting a particular workflow additionally benefits from knowing its subscription or transaction identifier. The 144-bit random server ID prevents blind enumeration and is a meaningful mitigation.

#### Evidence

- The implementation explicitly says the shared secret is “too weak for tenant isolation” at `apps/webhook-relay/src/registry.ts:25-29`.
- Deployment instructs the home server and relay worker to share the same global value (`docs/webrtc-deployment.md:279-288`).
- Backhaul authentication signs attacker-supplied `<serverId>\n<timestamp>` under that one secret (`apps/webhook-relay/src/registry.ts:169-190`).
- Once verified, the relay accepts that asserted identity without an installation-specific key (`apps/webhook-relay/src/registry.ts:232-240`).
- A new connection for the same `serverId` evicts the incumbent at `apps/webhook-relay/src/registry.ts:248-266`. The behavior is intentional and covered by `apps/webhook-relay/src/registry.test.ts:441-461`.
- Webhook ownership considers an existing registration valid when the asserted server ID matches (`apps/webhook-relay/src/registry.ts:309-322`).
- Delivery selects any open socket tagged with that ID (`apps/webhook-relay/src/registry.ts:468-490`, `apps/webhook-relay/src/registry.ts:543-552`).
- OAuth transaction registration likewise stores the self-asserted ID (`apps/webhook-relay/src/registry.ts:333-344`).
- Server IDs are random 18-byte base64url values (`src/server/hostCore/deviceAuthStore.ts:336-365`), which mitigates discovery but makes the ID function as a second bearer secret rather than a verifiable identity.

#### Impact

A holder of the global secret that learns a victim ID can connect as that victim, evict the legitimate backhaul, receive webhook payloads and OAuth handoffs routed to the victim tag, and acknowledge or disrupt deliveries. “First writer wins” protects an ID from a different asserted server ID, but it does not help when the attacker can authenticate as the same ID.

#### Recommended synthesis

Give every installation an asymmetric relay identity:

- generate a non-exportable or OS-protected key pair during enrollment;
- have the relay bind `serverId` to the public-key fingerprint;
- authenticate reconnects by signing a relay challenge;
- support key rotation and explicit revocation;
- sign relay envelopes with a relay service key, separate from tenant authentication.

Enrollment can happen automatically during the existing setup/pairing experience. Reconnects remain prompt-free. Stable key identity also simplifies recovery: the server ID becomes a label for a cryptographic principal, not a hidden second password.

Do not add per-tenant branches around the existing global secret. The clean boundary is an installation identity primitive used consistently by webhook and OAuth routing.

#### Relay identity options

Three coherent designs were considered:

1. **Per-install symmetric keys.** Operationally simple, but the relay must retain a
   tenant authentication secret and either distribute or recover it. A relay database
   disclosure becomes an impersonation event unless keys are separately wrapped.
2. **Installation signing keys (recommended).** The installation generates an Ed25519
   key pair, the relay stores only the public key, reconnect uses a relay nonce plus
   transcript-bound signature, and `serverId` is derived from or permanently bound to
   the public-key fingerprint. This gives clear rotation/revocation semantics and a
   relay database leak does not reveal tenant impersonation keys.
3. **Control-plane-issued short-lived certificates.** Strong when a mature account
   control plane and certificate lifecycle already exist, but adds an issuer,
   refresh/recovery path, and availability dependency that the current self-contained
   installation does not otherwise need.

Because compatibility and staged rollout are not requirements, the monorepo should
replace the global HMAC in one coordinated cutover. On first enrollment, an existing
authenticated setup/pairing flow authorizes the new public key. Subsequent connections
use:

1. installation sends key ID/public-key fingerprint;
2. relay returns a single-use nonce, relay audience, protocol version, and expiry;
3. installation signs the canonical transcript including its intended `serverId`;
4. relay verifies the bound public key, consumes the nonce, and admits exactly that
   installation;
5. a second valid connection for the same key may retain the current incumbent-eviction
   behavior, while a different key can never claim that ID.

Webhook/OAuth delivery envelopes should independently carry a relay-service signature
and destination key ID. Tenant authentication then answers “which installation is
connected”; envelope signing answers “did the relay produce this delivery.” Rotation
registers a new public key through an authenticated old-key or account recovery action,
then revokes the old key. Loss recovery must be explicit; silently accepting a new key
for an existing ID would recreate the original defect.

---

### SV-04 — Runtime relay is fail-open outside the Durable Object authority path

**Severity:** Medium\
**Confidence:** High that the boundary is open; medium on exploit impact because impact depends on methods a target runtime exposes\
**Affected properties:** Confidentiality, integrity\
**Preconditions:** The attacker is an authenticated workspace participant/runtime and knows or discovers a target runtime ID and exposed method.

#### Evidence

- `checkRelayAuth` documents that relay is open between authenticated participants and defaults to `{ ok: true }` when no policy is supplied (`src/server/rpcServer.ts:2755-2783`).
- The production workspace `RpcServer` construction at `src/server/index.ts:2700-2843` does not provide `relayAuthorization`.
- The hub correctly supplies a fail-closed relay policy (`src/server/hubServer.ts:1723-1729`), demonstrating that the hook is available but not a workspace receiver contract.
- HTTP tests intentionally assert that a worker may relay to unrelated panel and shell targets (`src/server/rpcServer.httpRpc.test.ts:858-891`).
- Panel/shell calls are forwarded to the target bridge at `src/server/rpcServer.ts:2849-2858`.
- Regular-worker calls are forwarded using a host-stamped envelope but without a target/method authority decision at `src/server/rpcServer.ts:3441-3481`.
- The worker dispatches the received envelope to methods registered with `runtime.expose()` (`packages/runtime/src/worker/index.ts:341-355`, `packages/runtime/src/worker/index.ts:383-402`).
- By comparison, direct Durable Object calls have an exact build-catalog and authority-attestation path beginning at `src/server/rpcServer.ts:2915-2920` and wired through `src/server/index.ts:2737-2813`.

#### Impact

Any exposed panel, shell, or regular-worker method is transport-callable by any authenticated participant unless the receiver implements its own check. Current built-ins include panel agent inspection/mode methods (`packages/runtime/src/panel/agentApi.ts:65-72`), and workspace code can add arbitrary methods through the ergonomic `expose` API (`packages/runtime/src/setup/createBaseRuntime.ts:237-239`).

This is an authorization asymmetry, not proof that every exposed method is sensitive. It becomes a vulnerability as soon as a receiver assumes the transport enforces parent/owner/source or method authority.

#### Recommended synthesis

Introduce **receiver-declared RPC contracts** for all hosted runtime types:

- each exposed method declares accepted principal shapes and semantic effect;
- build/runtime registration produces a compact method catalog;
- the host checks target, method, caller, and active receiver incarnation before relay;
- the host stamps an attestation for regular workers just as it does for DOs;
- missing declarations fail at build/startup, not as repeated user prompts.

Keep `runtime.expose()` ergonomic by accepting a typed contract alongside the handler or deriving it from a declared service schema. Receivers can explicitly declare open collaborative methods. Parent-only or owner-only methods become structural relationships rather than string-prefix special cases.

---

### SV-05 — OAuth client configuration does not bind secret use to configured endpoints

**Severity:** Medium\
**Confidence:** High\
**Affected properties:** Confidentiality, integrity\
**Preconditions:** An untrusted runtime has `accounts.connect`, knows a configured client ID, selects a flow that uses stored client material, and obtains the user's credential-connection approval. The approval carries `oauthTokenOrigin`, which is an important social/UX mitigation.

#### Evidence

- Client configuration stores a provider `tokenUrl` (`packages/service-schemas/src/credentials.ts:427-439`).
- Noninteractive connection requests also accept their own `tokenUrl` alongside a `clientConfigId`, including client credentials, JWT bearer, and token exchange (`packages/service-schemas/src/credentials.ts:575-618`).
- `loadClientConfigForFlow` verifies only existence/status and allowed flow type (`src/server/services/credentialConnectionCoordinator.ts:2420-2428`).
- Client-credentials flow reads the secret/private key from the selected config at `src/server/services/credentialConnectionCoordinator.ts:1335-1346`, but sends it to `request.flow.tokenUrl` at `src/server/services/credentialConnectionCoordinator.ts:1368-1378`.
- JWT bearer repeats the pattern at `src/server/services/credentialConnectionCoordinator.ts:1421-1457`.
- Token exchange can send both configured client authentication and an existing subject access token to the requested URL (`src/server/services/credentialConnectionCoordinator.ts:1495-1554`).
- Device code uses configured client authentication with caller-selected authorization and token endpoints (`src/server/services/credentialConnectionCoordinator.ts:1787-1835`, `src/server/services/credentialConnectionCoordinator.ts:1877-1891`).
- The approval request does include the requested token origin (`src/server/services/credentialService.ts:948-995`). This prevents classifying the issue as a silent, no-user-interaction exfiltration.

#### Impact

The configured secret's true audience is not enforced. A runtime can reuse material entered for provider A at an endpoint it supplies, subject to user approval. The UI displays the token origin, but the API shape still makes the user reason about a low-level security invariant on every connection and allows a misleading credential label/audience to compete with that detail.

#### Recommended synthesis

Make a client configuration a typed **provider trust bundle**:

- bind authorize, device, token, userinfo, and revocation audiences to the config and config version;
- flows reference endpoints by role instead of resupplying raw URLs;
- custom/tenant-specific endpoints are configured once in the trusted provider-configuration flow;
- a change of endpoint creates a new config version and one clear trust review.

This reduces approval fatigue: ordinary connections ask “connect this account,” while endpoint trust is reviewed only when the provider configuration changes. It also composes naturally with the resolved-and-authorized HTTP client from SV-02.

---

### SV-06 — OIDC webhook verification grants an unconstrained metadata fetch

**Severity:** Medium\
**Confidence:** High\
**Affected properties:** Confidentiality, availability\
**Preconditions:** A runtime with `webhooks.manage` creates an OIDC-JWT subscription with a chosen JWKS URL, then triggers the public webhook endpoint with a syntactically valid unsigned/invalid JWT whose issuer and audience match the configured values.

#### Evidence

- The schema accepts any syntactically valid URL for `jwksUrl` (`packages/service-schemas/src/webhookIngress.ts:60-68`).
- `webhooks.manage` is presented as “Manage incoming web connections” (`packages/shared/src/authority/hostCapabilityPresentations.ts:1135`) and covers subscription creation (`packages/shared/src/authority/hostMethodCapabilities.ts:168-173`).
- The value is persisted during subscription creation (`src/server/services/webhookIngressService.ts:249-286`).
- Both direct and relay deliveries call OIDC verification (`src/server/services/webhookIngressService.ts:565-584`).
- Verification fetches the configured URL before signature validation (`src/server/services/webhookIngressService.ts:818-854`).
- `getJwks` uses plain `fetch(url)` and then buffers/parses the complete JSON response, with no timeout, response-size/JWK-count limit, redirect reauthorization, or network-address policy (`src/server/services/webhookIngressService.ts:868-881`).
- The ingress route is intentionally public (`src/server/services/webhookIngressService.ts:600-609`).

#### Impact

This is a blind SSRF and resource-exhaustion primitive hidden inside an incoming-webhook authority. It can target local/private services, follow redirects, or keep the server waiting on a hostile endpoint. After a malicious subscription is created, public requests can retrigger cache misses or expired cache entries.

#### Recommended synthesis

Use a **trusted metadata fetcher** built on SV-02's outbound client:

- HTTPS by default;
- issuer-to-JWKS origin binding unless a custom metadata host is explicitly configured;
- redirect and resolved-address reauthorization;
- short connect/overall timeouts;
- compressed and decompressed body ceilings;
- maximum JWK count/key size;
- bounded cache TTL and stale-if-error behavior.

Preserve enterprise/custom OIDC by reviewing a custom issuer/metadata trust bundle once. Do not hardcode Google or add a list of provider exceptions.

---

### SV-07 — Direct webhook body lacked a bounded subscription contract (resolved)

**Severity:** Medium\
**Confidence:** High\
**Affected property:** Availability\
**Preconditions:** The attacker can reach the loopback gateway. No valid subscription ID or webhook signature is required.

#### Evidence at the reviewed revision

- The route is public (`src/server/services/webhookIngressService.ts:600-609`).
- `handleIngressRoute` reads the entire body before looking up the subscription at `src/server/services/webhookIngressService.ts:479-491`.
- `readRawBody` appends all chunks and `Buffer.concat`s them without a ceiling (`src/server/services/webhookIngressService.ts:780-786`).
- Direct webhook URLs are currently loopback-only (`src/server/index.ts:2539-2545`), limiting reach.
- The public Cloudflare relay already has a 1.5 MB body ceiling and a per-subscription durable-buffer cap (`apps/webhook-relay/src/registry.ts:65-77`, `apps/webhook-relay/src/registry.ts:398-426`). The missing budget is specific to the direct path.

#### Impact

An attacker can send an arbitrarily large body to any guessed subscription path, causing unbounded memory growth before the server can return 404 or 401. Repeated or concurrent requests can terminate the process.

#### Recommended synthesis

Adopt the shared staged-ingress primitive from SV-01:

- perform cheap route/subscription lookup before body buffering;
- enforce a subscription/provider-specific maximum while streaming;
- compute HMAC/hash incrementally;
- return 413 as soon as the ceiling is crossed;
- use a bounded stream or spool only for explicitly approved large-webhook subscriptions.

Provider-level replay state should also move from the process-local maps at `src/server/services/webhookIngressService.ts:193-196` into the existing WebhookStore Durable Object when replay rejection is configured. That is a hardening item rather than the primary finding: timestamped signatures and optional replay policy already mitigate many replay cases.

#### Implemented remediation

The direct route now looks up and validates the subscription before consuming request data.
Every subscription persists a positive integer `maxBodyBytes`; the v3 WebhookStore migration
assigns the safe 1,500,000-byte default to existing rows, and invalid legacy/runtime values fail
closed before reading. Relay subscriptions can select any smaller budget up to the relay's
1,500,000-byte limit. Direct subscriptions must explicitly opt into larger payloads and cannot
exceed the operator-configured `VIBESTUDIO_WEBHOOK_DIRECT_MAX_BODY_BYTES` ceiling (16 MiB by
default, with a validated 64 MiB hard maximum derived from the current raw-body plus
`rawBodyBase64` memory contract).

The direct reader rejects an oversized declared `Content-Length` before buffering, stops and
drains a chunked request as soon as its subscription budget is crossed, and returns an actionable
HTTP 413 containing the subscription and effective host ceilings. Relay delivery checks decoded
base64 size before allocating the decoded Buffer, so a smaller per-subscription relay budget is
also enforced. Existing provider signature verification and successful-delivery behavior are
unchanged.

## Hardening opportunities

These did not meet the threshold for a standalone vulnerability in the current reachability model, but they should be incorporated into the same abstractions.

### H-01 — Session bearer lifetime and granularity

`TokenManager` creates one 256-bit token per caller (`packages/shared/src/tokenManager.ts:40-67`), validates by in-memory lookup with no expiry (`packages/shared/src/tokenManager.ts:122-127`), and can re-register persisted tokens after restart (`packages/shared/src/tokenManager.ts:87-108`). Revocation listeners correctly disconnect sessions (`packages/shared/src/tokenManager.ts:148-167`).

A stolen token therefore remains useful until caller-wide revocation or lifecycle teardown, and one connection cannot be retired independently. Prefer short-lived, audience/boot/workspace/generation-bound session access tokens minted from durable device/agent credentials. Refresh should be automatic in clients; do not impose repeated prompts or abruptly expire active agent runs.

### H-02 — Aggregate budgets for authenticated bulk traffic

The WebRTC pre-open buffer is bounded, but its defaults are intentionally very large: 65,536 pending streams and 1 GiB aggregate bytes (`src/server/rpcServer.ts:258-265`). Per-stream caps, condemnation, TTL, and bookkeeping are well designed (`src/server/rpcServer.ts:3878-4004`).

Replace global catastrophic ceilings with adaptive per-principal and per-connection budgets plus backpressure. Legitimate bulk agent workflows should reserve or stream capacity; one compromised authenticated principal should not be able to consume the entire host budget.

### H-03 — Live membership checks on all HTTP bearer paths

HTTP RPC checks live workspace membership (`src/server/rpcServer.ts:2621-2636`), and every post-auth WebSocket frame passes the live caller gate (`src/server/rpcServer.ts:1798-1815`). Generic `caller-token` service/worker routes only validate the token map (`src/server/gateway.ts:920-934`).

Route admission should consume the same verified-caller/live-membership primitive as RPC. This avoids depending on best-effort token revocation propagation and prevents route-specific identity drift.

### H-04 — Response and decompression budgets

Non-stream proxy APIs buffer complete upstream responses (`src/server/services/egressProxy.ts:432-438`, `src/server/services/egressProxy.ts:650-656`). Even an authorized endpoint can be compromised or return an accidental enormous response. Put response-size and decompressed-size ceilings in the resolved HTTP client, while retaining the existing streaming API for large legitimate responses.

## Verified protections and non-findings

The following controls were explicitly checked so future remediation does not regress or duplicate them.

### Gateway and browser boundary

- The primary gateway is loopback-only and public TLS ingress is decommissioned (`src/server/index.ts:2668-2684`, `src/server/gateway.ts:501-503`).
- Authentication uses bearer headers/grants rather than ambient cookies. No generic cookie-CSRF path was found.
- Reverse proxying strips inbound authorization, cookies, proxy authorization, and `x-vibestudio-*` headers before stamping the internal upstream credential (`src/server/gateway.ts:718-735`).
- Workerd DO dispatch requires both caller admission and a separate host dispatch secret (`src/server/gateway.ts:379-415`).

### Identity, tokens, and revocation

- Caller fields in HTTP envelopes are explicitly treated as untrusted; only the transport-derived caller reaches dispatch (`src/server/rpcServer/httpRpcHandler.ts:113-121`).
- Admin-token comparison is constant-time and fail-closed when unconfigured (`packages/shared/src/tokenManager.ts:15-33`, `packages/shared/src/tokenManager.ts:192-205`).
- Tokens use 32 cryptographically random bytes (`packages/shared/src/tokenManager.ts:64-67`).
- Panel bearer tokens have been removed in favor of connection grants (`packages/shared/src/tokenManager.ts:56-59`).
- Connection grants are 256-bit, single-use at redemption, incarnation-bound for code principals, and bounded after redemption (`packages/shared/src/connectionGrants.ts:43-109`, `packages/shared/src/connectionGrants.ts:112-151`).
- The WebSocket path re-checks account/device/agent/workspace liveness before every post-auth frame (`src/server/rpcServer.ts:1798-1815`).

### Persistence and path safety

- The hub is the sole identity writer; workspace children open the same database with SQLite `query_only` enabled (`packages/identity/src/identityDb.ts:1-16`, `packages/identity/src/identityDb.ts:133-166`).
- Credential record identifiers are constrained to safe single path components (`packages/credential-client/src/encryptedJsonStore.ts:7-15`, `packages/credential-client/src/encryptedJsonStore.ts:169-175`).
- Credential records are encrypted with Electron safe storage when available or AES-256-GCM otherwise, and key/record files use restrictive modes (`packages/credential-client/src/encryptedJsonStore.ts:70-131`, `packages/credential-client/src/encryptedJsonStore.ts:181-193`).
- App artifact paths reject absolute paths and `..` segments, and access is restricted to active/previous approved build keys (`src/server/appHost.ts:1178-1209`, `src/server/appHost.ts:2562-2565`).

### Privileged bridges

- CDP and inspector bridges use target-bound, expiring, single-use grants rather than long-lived query-string admin credentials (`packages/shared/src/cdpGrants.ts:23-68`; `src/server/cdpBridge.ts:314-330`; `src/server/workerdInspectorBridge.ts:90-128`).
- Direct Durable Object calls have materially stronger receiver authorization than generic relay: exact build catalog, method effect, active identity, and host attestation are present. The remediation for SV-04 should extend this good abstraction, not replace it.

### Multi-instance boundary

Developer instances isolate leases, ports, databases, workspaces, and runtime state, while provider configuration and encrypted credentials are profile-scoped by design. This is an operational isolation boundary, not protection against a malicious process running as the same OS user. The fallback AES key and ciphertext being accessible to that same user is therefore not reported as a vulnerability. If adversarial same-user instance isolation becomes a product goal, it requires OS keyring/ACL/process isolation rather than another application flag.

## Remediation order

1. **Relay identity (SV-03):** it is a cross-tenant architectural boundary and should be fixed before broad production distribution of the shared secret.
2. **Resolved outbound HTTP client (SV-02, then SV-06 and SV-05):** one implementation removes multiple SSRF and secret-audience gaps.
3. **Receiver-declared RPC contracts (SV-04):** inventory exposed methods, derive contracts, then switch transport authorization from default-allow to catalog-driven enforcement.
4. **Lifecycle hardening (H-01 through H-04):** adopt as part of the above primitives rather than separate compatibility flags.

SV-01 and SV-07 were remediated during this review and are therefore removed from the open
remediation order.

## Remediation validation

- Typed-admission focused host suite: 15 files, 340 tests passed.
- Webhook-budget and headless-diagnostic focused suite: 6 files, 79 tests passed.
- Workspace CDP client: 18 tests passed.
- Host TypeScript checks, including workerd programs: passed.
- Workspace desktop, integration, and mobile TypeScript checks: passed.
- Scoped production-file ESLint: passed with no errors or warnings.
- `git diff --check`: passed.

## Review limits

This was a source-level review of the checked-out revision, supported by reading focused existing tests and architecture documentation. It did not include live cloud configuration inspection, dependency-CVE scanning, fuzzing, packet capture, or destructive exploit execution. The callback relay's production secret distribution and Cloudflare access policy were not externally verified. Product UI rendering of every approval detail was not manually exercised; where an origin is structurally included in the approval model, that mitigation is credited explicitly.

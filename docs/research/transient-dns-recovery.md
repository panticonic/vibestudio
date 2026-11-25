# Transient authorized DNS recovery

Inventory before edits (2026-11-25), baseline Host 7da3add88.

Actual V27 native records contain one `getaddrinfo EAI_AGAIN chatgpt.com`
chooser failure and a separate `fetch failed` failure. The latter's originating
cause is not established. No network or model probes were made.

The shared `packages/shared/src/networkDestination.ts:98` resolves all addresses
before returning an immutable vetted snapshot/pinned lookup. Consumers are:

- `src/server/services/egressProxy.ts`: authorized HTTP/SSE requests (1326),
  WebSocket upgrades through the same request executor (2646), raw TCP (2492),
  and internal platform callbacks (1072).
- `packages/shared/src/chromiumNetworkProxy.ts:23,60`: browser HTTP and CONNECT.
- `src/server/services/hostHttpTransport.ts:38`: trusted public bootstrap reads.

The executor resolves before its per-attempt catch; DNS failures bypass existing
HTTP retry handling. Streaming HTTP explicitly has zero request retries (778),
which must remain true after a partial response. Each attempt creates a pinned
Agent and destroys it (1331,1413); cross-turn pooling is a separate lifetime and
revalidation design, excluded from this repair.

Base `packages/agentic-do/src/native-model-transport.ts:572-608` routes all
credentialed/passthrough model fetches to the Host credential transport. Its
WebSocket path uses host egress too. ModelGateway's protected provider calls this
shared transport; model score/stream variants do not require separate DNS logic.
`packages/rpc/src/errors.ts:276-309` already serializes error causes and system
fields; no demonstrated cause-loss defect is repaired here.

Core `ts-host/src/model/chat-completion.ts:590-601` direct Node model fetch uses a
retained undici Agent; browser fetch uses the browser resolver. Those standalone
engines do not call this Host authority/pinning boundary. Managed local llama,
Python/SGLang and in-page wllama likewise do not consume Host authorized DNS;
they are excluded from this Host DNS-specific change. The native Vibe execution
route instead receives the protected transport above. No model invocation or
stream replay policy changes.

Repair scope: only actual resolver EAI_AGAIN gets at most two additional DNS
attempts, inside the existing resolution deadline, with cancellable backoff.
No connection, request body, provider invocation or response is retried. The final
original resolver error is preserved. Successful answers still pass the entire
public/private and host-interface validation and retain exact hostname/SNI
pinning. A caller can disable transient retries explicitly. NXDOMAIN, authority
refusals and malformed/mixed answers are never retried.

Verification: focused source Vitest component suite passed all 12 tests in unit
`vibe-authorized-transient-dns-20261125a` (LOW 0.75 GiB, reserve 5.5 GiB,
heap 384 MiB; observed peak 91.4 MiB, 845 ms). Tests use injected DNS answers;
no real network, model calls or provider stream replay. This qualifies the shared
DNS policy, not a claim that the system resolver outage or generic fetch failure
has been independently repaired or that a live provider retry was exercised.

Scoped syntax lint (type-aware mode explicitly disabled), formatting and diff
checks passed. Typed verification remains unchecked: the standalone TypeScript
check exceeded its 0.75 GiB diagnostic cap; the repository's default oxlint
configuration also enables project-wide typed analysis even for named files and
exceeded a separate 0.35 GiB cap. Neither is a passed type check; no cap ladder or
full build was started. The component suite above completed independently.

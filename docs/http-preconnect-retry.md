# Proven preconnect HTTP retry

Inventory before editing (production Host34de): `hostHttpTransport.ts`
`requestHostHttp` is the common vetted-dispatcher HTTP primitive, used by
buffered credential/public egress and Git HTTP (`egressProxy.ts:658,922`) and
anonymous public bootstrap (`hostGitHttpClient.ts` via `withPublicHostHttp`).
Response-streaming credential egress alone calls raw fetch (`egressProxy.ts:780`)
and disables its outer retries, so it bypasses that common primitive.
`credentialClient.ts:192–255` serializes request bodies to string/base64 before
RPC stream; Base `native-model-transport.ts:730–775` buffers the real provider
request and calls this client. Thus provider SSE responses stream, while their
request bodies reach Host as replayable bytes. The alternate raw upload stream
path in `rpcServer/streamingRelay.ts:662` remains nonreplayable.

Protected provider credential and public native-model requests share this
Host egress boundary, independent of provider name. Native model WebSocket
upgrades instead use the explicit upgrade path and existing retry policy; they
are not HTTP body replay consumers. Chromium fetch/proxy requests use their own
browser-owned transport and cannot expose this authoritative Node error chain.
Anonymous gatewayFetch is an internal loopback asset bridge, not public protected
provider egress. Direct OAuth/revocation acquisition is a separate host operation,
not a consumer of this checked-dispatcher primitive. No global fetch replacement,
DNS/address rotation, TLS/trust change, timeout or provider-specific route is added.

Actual V29 diagnostic: fetch-head, aborted=false, TypeError cause AggregateError,
all leaf errors have syscall=connect and connection-network error codes. This
proves those attempts never established TCP; a generic fetch failure does not.
Retry once only when every leaf has this proof, the signal is live, and the
request body has a stable replayable snapshot. Streams/FormData/unknown bodies,
HTTP statuses, ambiguous failures, TLS failures and response body failures do
not enter this policy. Existing DNS EAI_AGAIN retry remains in
`packages/shared/src/networkDestination.ts` before request admission.

Retry ownership: outer buffered/Git idempotent-method retries retain their
existing policy and disable the new inner retry. Buffered provider POST no
longer claims semantic replay safety merely because its body is buffered.
Streaming responses have no outer retry; they enter the shared primitive before
any upstream head/body has reached the caller. Explicit
`VIBESTUDIO_HTTP_PRECONNECT_RETRY=0` disables the new retry. Existing caller
cancellation, vetted DNS snapshot, authority/audience checks, manual redirects,
owned dispatcher destruction and response-body retirement remain authoritative.

Focused baseline also exposed two stale raw-loopback approval expectations:
original34de denies before a capability prompt, correctly, because ordinary
network approval cannot authorize internal addresses. Tests retain403/no-upstream
assertions and now assert no prompt. They also exposed lost audit provenance on
pre-authorization denial: retain the already verified caller's repository path
instead of `unknown`, without granting authority or weakening address policy.
The original34de baseline independently reproduced both failures. New focused
checks retain existing owner/temporary-root setup, without booting a desktop.

Validation: actual focused Host HTTP/egress112 tests pass, including bounded
provider POST retry, no nested retry ownership, mixed aggregate/TLS/abort/body
negatives, streamed-body refusal and HTTP500 nonretry. Native TypeScript7
syntactic+semantic checks of the four changed source/test files, with inherited
Host options and real installed dependencies, pass. Scoped lint reports zero
errors/five existing warnings. This is not a full Host typecheck or a paid
provider smoke. The original historical terminated-body failures remain open.

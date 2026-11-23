# Chromium fetch network authority

## Inventory and observed defect

`packages/headless-renderer/src/chromiumFetchHost.ts` opens a BrowserContext and navigates directly. No destination validation, proxy, pinned lookup or caller network authority reaches that context. The public mode is cookie-isolated but is not a public-address-space boundary. A user-goal corpus must not replace this missing boundary with hidden expected-answer hostname lists.

Existing shared enforcement is `src/server/services/networkDestination.ts`: public address filtering, rejection of mixed DNS answers, exact internal-loopback origin authority, and a pinned Node lookup consuming one vetted DNS snapshot. `src/server/services/egressProxy.ts` already uses it for HTTP, redirects and CONNECT sockets. `egressListener.ts` and `socketBridge.ts` own listener/socket lifetime. Public Chromium must consume the same resolver and transport mechanisms, without credential injection or a second page-fetch stack.

## Responsibilities

| Concern | Owner |
| --- | --- |
| Cookie session versus network permission | Separate typed service inputs; public defaults to public address space |
| Caller/source authority | Main service dispatcher and prepared exact-origin capability, never a page, goal string, expected hostname or fixture nonce |
| Browser networking | Chromium BrowserContext proxy; implicit localhost bypass disabled |
| HTTP, HTTPS CONNECT, redirects and subresources | Shared egress destination validation and DNS-pinned sockets for every endpoint |
| Public content | Chromium still performs TLS, navigation and body extraction |
| Explicit local source | Exact approved loopback origin; other local destinations remain denied |
| Lifecycle | Proxy belongs to one owned open operation/context and closes on completion, cancellation or host retirement |
| Unrelated authenticated profile behavior | Must not implicitly grant local-network access; cookie projection is independent from endpoint authority |

## Components to update and verify

- `chromiumFetch` service schema/client and `chromiumFetchService.ts`: carry exact source authority through reviewed prepared selection, preserve owner-bound response reads.
- `panelRuntimeRegistration.ts` and `index.ts` composition: seal exact Host-owned native provider identity in a prepared origin grant. The trusted native provider creates its own local proxy, including when the general public provider is remote.
- `egressProxy.ts`, `networkDestination.ts`, `egressListener.ts`, `socketBridge.ts`: reuse canonical validation and socket forwarding; no duplicate address classification or unchecked DNS resolution.
- `ChromiumFetchHost` and `HeadlessHost` provider command: all public-context network traffic uses the supplied per-context proxy, including redirects/workers/subresources; reject unreviewed schemes and malformed proxy metadata.
- Browser launch: prevent direct nonproxied UDP paths where Chromium context proxy cannot cover them.
- Base web-core contracts/pages and System Testing owned-source binder: explicit loopback network request only for an authorized source; general public research uses default public grant. Coordinate Base/SST edits before source freeze.
- Tests: real listener requests for public/private rejection and exact loopback grants; pinned lookup/hostname mismatch and mixed DNS denial; context proxy parameters and cleanup; dispatch authority distinguishes public from local; source read/citation evidence remains independent.

The optional web request `network: {kind: "loopback", origin}` selects `chromiumFetch.openLocal(url, origin, cookieSession)`. The Host prepares a genuine `network.connect` exact-origin approval (and separate `credential.use` approval for browser cookies), captures the actual owned child provider, and validates the sealed request again at execution. No caller-owned boolean, fixture nonce, hidden expected hostname or static localhost regex confers authority. DNS classification remains solely in `resolveNetworkDestination` on the native machine. The local grant adds only its exact origin to the public destinations; every redirect and subresource is independently checked. The request authorizes a source; it does not claim to prove a remote shell endpoint is physically on this machine.

`HeadlessHostManager` now reuses only its own child, matching the client-session identity reported through that child's IPC, rather than adopting another registered headless provider. Cookie contexts are per operation so no context retains an expired network grant. URL evidence memoization includes both cookie session and explicit network origin.

Chromium configuration follows its official [proxy documentation](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md) (`<-loopback>` removes the implicit local bypass). Its [WebRTC policy](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/WebRtc/WebRtcIPHandling.yaml) forces non-UDP proxy transport; QUIC is disabled so it cannot become a separate UDP path.

Validation: shared resolver tests cover mixed-DNS rejection and pinned lookup; native proxy tests cover denied private destinations, exact-origin HTTP and CONNECT authority, and teardown. An opt-in actual Chromium test navigates and loads subresources through the real context proxy, verifies a granted source, and confirms private navigation, redirect, image and script requests produce no destination reads. No model inference is needed. Active release sources/caches remain unchanged.

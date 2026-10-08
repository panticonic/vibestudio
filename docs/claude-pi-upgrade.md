# Claude subscription sign-in and Pi 1.1.0

Vibestudio previously constructed Claude's OAuth request in its generic PKCE
connector. That duplicated the provider's redirect, scope and state contracts:
the generic connector generated an independent state, while pi's Anthropic flow
uses the PKCE verifier as state and owns its authorized callback. The screenshot
alone does not establish which parameter Claude rejected.

Claude subscription connections now use pi's native Anthropic provider, as do
the existing device-login providers. The trusted approval UI presents the
provider's method identifiers as choices. Browser login uses pi's owned local
callback; copy-code login uses Anthropic's hosted callback and works when the
browser and host are on different machines. Authorization and token exchange
use the same callback. Provider state remains encrypted and renewable; API-key
connections remain a separate explicit method.

The native callback settles the outstanding manual-code prompt. Caller
cancellation removes the pending prompt, and token-exchange failures reach the
caller without storing a credential. Invalid method values leave the approval
visible for correction.

## Upstream and other Pi integrations

- [Pi 1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)
  includes Anthropic's fallback to a free loopback port when the preferred port
  cannot bind.
- [Native Anthropic OAuth](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/ai/src/auth/oauth/anthropic.ts)
  owns browser/copy-code selection, PKCE, scopes, callback identity and renewal.
- [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) keeps native
  pi login and customizes the subsequent Messages transport.
- [pi-claude-request-compat](https://github.com/vazzma/pi-claude-request-compat)
  also retains native OAuth while exposing a separate compatibility provider.
  These transport extensions do not repair a malformed authorization request.

The maintained fork integrates the four distributed libraries through upstream
release 1.1.0 and reviewed main
`ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`. The exact distribution version is
`1.1.0-vibestudio.1` for AI, Durable, Chord and Telemetry. SDK dependency pins
already match this upstream revision. Workerd payload chunking, pinned model
requests, failure waits and continuation ownership remain part of the fork.

Verification covers both native Claude methods through the real coordinator,
refresh storage, cancellation and exchange rejection; upstream transport and
durable conformance tests; packed Base ownership tests; and trusted approval UI.
The release receipt records source and registry archive hashes. Actual account
authorization still requires completing sign-in with Claude.

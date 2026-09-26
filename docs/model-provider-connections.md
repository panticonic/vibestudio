# Connecting models in chat

Choose a **Provider** and **Model** in the chat panel's agent settings. If the
provider is not connected, setup appears below the model picker. Connect the
provider there before starting the agent; an opening message stays queued while
setup is incomplete.

Subscription sign-in is available for:

| Provider | Subscription |
| --- | --- |
| ChatGPT | ChatGPT Plus / Pro |
| Claude | Claude Pro / Max |
| GitHub Copilot | GitHub Copilot |
| Kimi Code | Kimi Code |
| Meta | Meta Muse |
| xAI | SuperGrok / X Premium |

Choose the workspace browser or system browser with the account you want to use.
For device sign-in, the trusted approval bar displays the provider's code while
the browser opens. GitHub Copilot also asks for an optional Enterprise domain.
Provider-specific token exchange and renewal stay on the host; the chat panel
never receives access tokens or refresh tokens.

API-key setup is available across the catalog. Azure asks for its OpenAI endpoint;
Cloudflare asks for the account and, for AI Gateway, gateway ID. The API key itself
is entered in the trusted secure-input prompt. Bedrock's guided key method uses
a Bedrock API key; Vertex's key method uses an express-mode API key.

After setup, the chat refreshes connection status. Account-specific endpoints
are applied to model requests, and provider-reported model restrictions are
shown instead of marking inaccessible models ready. A failed sign-in can be
retried, and an in-progress setup can be cancelled. Expired connections can be
reconnected from the same UI. Stored configuration is retained for key replacement.

ChatGPT and Claude subscription clients require desktop loopback callbacks.
On mobile, the setup card explains this requirement; device-code providers and
API-key setup remain available. A connection established on the shared host from
a desktop can still be used by its mobile chat clients.

## Maintaining provider support

`packages/shared/src/providerConnect.ts` owns methods, endpoint configuration,
and injection policy. Regenerate fixed-endpoint key definitions after upgrading
Pi with `node scripts/generate-provider-connect.mjs`. The catalog tests require
that every catalog provider has guided setup and every method creates a valid
credential request with its declared configuration.

Native PKCE providers use the credential coordinator's browser callback support.
Device subscription providers use Pi's login, renewal, request-auth derivation,
and account-model filtering through the host credential mechanism. Provider
session state is encrypted in the existing credential store.

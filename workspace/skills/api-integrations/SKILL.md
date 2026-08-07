---
name: api-integrations
description: Use, build, or diagnose external APIs and URL-bound credentials, including safe missing-credential outcomes, approval-gated browser opens, and provider setup workflows.
---

# API Integrations Skill

Credentials are URL-bound and may only be used through host-mediated egress.
Provider setup should be user-friendly: when a provider requires console work,
OAuth app creation, webhook registration, or API enablement, render a workflow
UI with deep links instead of writing a long plain-text checklist.

## Missing-Credential Outcomes

Treat a missing credential as a normal setup state, not as a reason to search
the repository for provider details or to invent an audience, endpoint, or
secret. If the request does not identify the provider and target URL clearly
enough to create a correct URL-bound credential, explain the trusted setup flow
and ask for those non-secret details. Do not open a credential prompt with
placeholder values.

Credential IDs are opaque identifiers. Preserve the complete value exactly as
provided—including prefixes such as `credential:`—when passing
`{ credentialId }`; never trim, split, or normalize it.

When a read-only diagnostic intentionally checks a known missing credential,
keep the eval result bounded. Convert only the canonical
`credential-unavailable` outcome to `{ missing: true }`, and rethrow every
other error:

```ts
import { credentials } from "@workspace/runtime";

try {
  await credentials.fetch(url, undefined, { credentialId });
  return { missing: false };
} catch (error) {
  if (!String(error).includes("credential-unavailable")) throw error;
  return { missing: true };
}
```

Do not return the raw error object, credential metadata, or request details.
In eval, `credentials` is imported from `@workspace/runtime`; it is not an
ambient global and there is no raw host-service equivalent to
`credentials.fetch`.

When the provider and audience are known, call the appropriate host-owned
credential or OAuth setup API once. A denial or cancellation means setup did
not complete; report that outcome and stop. In particular, an unattended host
may automatically deny value-entry prompts because auto-approval cannot invent
client ids, tokens, or secrets. Do not retry the prompt, inspect application
source looking for a secret, switch to raw credential-service RPC methods, or
ask the user to paste the value into chat.

Use the `credentials` namespace exported by `@workspace/runtime`. Its public
methods include `store`, `requestCredentialInput`, `connect`, `fetch`,
`hookForUrl`, `gitHttp`, and `forAudience`; lower-level wire transports are not
an alternative public API. When working as a direct service/RPC caller instead
of through this runtime client, use the exact wire method
`credentials.storeCredential`; do not call a wire method named
`credentials.store`.

## UX Rules

1. Use one persistent `inline_ui` workflow for setup flows with multiple
   steps. Its controls call trusted setup helpers directly; never return
   choices to the agent merely to assemble the same helper call.
2. Put provider-console links directly beside the step that uses them.
3. Offer both **Internal** and **External** opens when a URL is useful:
   - Internal: `openPanel(url, { focus: true })`
   - External: `openExternal(url)`
4. Use `openExternal(authorizeUrl, { expectedRedirectUri })` for OAuth
   authorize URLs so the host validates the callback binding.
5. Do not ask the user to paste secrets into chat. Use a trusted provider setup
   UI/API or host-owned credential flow.
6. Ask about user outcomes, not credential formats, OAuth vocabulary,
   permission-scope names, transport modes, or storage mechanics. Apply a
   recommended default and put exceptional choices behind an Advanced path.
7. Keep provider choice, access intent, browser actions, credential collection,
   progress, errors, and retry in the same workflow whenever they belong to one
   setup attempt.
8. Use `feedback_custom` only when the agent genuinely needs a returned
   decision for later reasoning. It is not the default provider-setup surface.

## Runtime Credential API

Store static tokens only when the provider does not support a better OAuth flow:

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

When a static token or API key must be entered by the user, do not collect it in
chat or panel-owned React state. Use the host-owned credential input prompt.
This prompt currently supports one required secret field; multi-field setup
material belongs in client config or another provider-specific setup API.
The secret is entered in Vibestudio's shell UI and stored encrypted after
submission, but it is not exposed to panels, workers, or chat state.

```ts
const stored = await credentials.requestCredentialInput({
  title: "Add Example API",
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
    metadata: { providerId: "example" },
  },
  fields: [{ name: "token", label: "Token", type: "secret", required: true }],
  material: { type: "bearer-token", tokenField: "token" },
});
```

Use host-owned OAuth when userland should connect an OAuth provider but should
not compose redirects or receive the access token. Do not pass client secrets
through userland; use `credentials.configureClient()` for flows that need
stored OAuth client material. A saved `configId` is bound to its OAuth authorize
and token URLs; use a new `configId` if those endpoints change.

Set `persistRefreshToken: true` when the provider issues durable refresh tokens
and the connection should renew without another sign-in. The host persists the
token together with its exact public-client recipe or exact client-config
version. Check `stored.lifecycle.canRefresh`; requested `offline_access` or a
stored credential by itself is not proof of renewability. `stored.scopes`
reports the provider-granted scope when the token response supplies it.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  browser: "external", // or "internal" for an app browser panel
});
```

### Choosing an OAuth flow type

| Flow                                          | When to use                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oauth2-auth-code-pkce`                       | Authorization-code flow for public or confidential clients. PKCE is always required.                                                                                                                                                                                           |
| `oauth2-device-code`                          | Provider issues a short code the user types into a verification page. Best fallback when redirect-based flows can't reach the server — e.g., providers that won't accept a Tailscale `*.ts.net` redirect URI, headless installs, environments without app-link infrastructure. |
| `oauth2-client-credentials`                   | Server-to-server. No user identity.                                                                                                                                                                                                                                            |
| `oauth2-jwt-bearer` / `oauth2-token-exchange` | Federated / STS-style.                                                                                                                                                                                                                                                         |
| `oauth1a`                                     | Legacy providers (some Twitter/X API surfaces).                                                                                                                                                                                                                                |

### Device-code flow

When you call `credentials.connect()` with `type: "oauth2-device-code"`, the server:

1. Hits the provider's `device_authorization_url` to obtain a `device_code`, `user_code`, and `verification_uri`.
2. Opens the verification URL in the user's browser (uses `verification_uri_complete` when the provider supplies it — Google, GitHub, Microsoft all do — so the page is pre-filled).
3. **Surfaces the `user_code` on the trusted approval bar** as a `device-code` approval entry. The user can read the code there even when the provider didn't pre-fill it, and can cancel the flow with one click.
4. Polls the token endpoint at the provider-specified interval until either a token grant arrives or the user cancels / the device code expires.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-device-code",
    deviceAuthorizationUrl: "https://oauth2.googleapis.com/device/code",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "public-client-id",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
  credential: {
    label: "Google Drive",
    audience: [{ url: "https://www.googleapis.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
});
```

Providers known to support device code: **Google, Microsoft / Azure AD, GitHub,
GitLab, Slack, Twitch, Spotify, Dropbox, Atlassian, Discord.** Apple does
**not** support device code; see the credential-system docs for Apple options.

Use credentials only through host-mediated egress:

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

Use `credentials.gitHttp()` for Git smart HTTP traffic. Do not route git
packfiles through `credentials.fetch()`, and do not expose PATs to userland
`onAuth` callbacks:

```ts
import { credentials, fs } from "@workspace/runtime";
import { GitClient } from "@vibestudio/git";

const client = new GitClient(fs, { http: credentials.gitHttp() });
await client.clone({ url: "https://github.com/owner/repo.git", dir: "/repo" });
const status = await client.status("/repo");
```

When the caller needs external Git transport, use `@vibestudio/git` with
`credentials.gitHttp()` so credentials stay host-mediated.
Use `client.status(dir)` for structured status and `client.statusMatrix(dir)`
only when raw isomorphic-git HEAD/WORKDIR/STAGE tuples are required.

To share a git remote across future contexts, use the runtime git remote API
instead of editing only the current `.git/config`:

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("panels/my-panel", {
  name: "origin",
  url: "https://github.com/owner/my-panel.git",
  branch: "main",
});
```

For an external repository that should live under workspace source, use
`git.importProject()` with the destination path:

```ts
const imported = await git.importProject({
  path: "skills/example",
  remote: {
    name: "origin",
    url: "https://github.com/owner/example.git",
    branch: "feature/workspace-integration",
  },
  credentialIdOverride: "cred_github_...", // call-scoped only; never persisted
});

console.log(
  imported.candidate.contextId,
  imported.candidate.eventId,
  imported.candidate.semanticEvidence
);
```

The clone produces a committed semantic candidate and does not advance
protected `main`. Bring `imported.candidate.eventId` into the intended working
context with ordinary `vcs.compare` and bounded coordinate `vcs.merge` pages, check it,
commit the complete local chain, and call `vcs.push` explicitly when
publication is intended.

The candidate's required `semanticEvidence` is returned by the same atomic
semantic import and names the exact application, import work unit, source
revision/digest, and target repositories. Do not substitute clone metadata or a
post-commit reconstruction.

Persist only a logical upstream `credential` name, never a concrete credential
ID. It is resolved by the host for that workspace and remote URL; a
`credentialIdOverride` is call-scoped, and credential-free declarations are
anonymous-first. Persist only credential-free HTTP(S) remote URLs without query
parameters or fragments.

Use one explicit userland `git.importProject()` per absent repository. It
freezes exact source coordinates, produces an unpublished semantic candidate,
and never changes protected main by itself. Upstream declarations do not cause
host startup imports. Operational clones live below server
`state/git-checkouts/` and never become Build V2 source directly.

`git.importProject()` uses one workspace config approval covering the shared
remote and upstream; the prompt shows the destination path, remote URL, and
branch. Both declarations are written to `meta/vibestudio.yml` before clone,
with `autoPush: false`. That setting controls only later outgoing Git pushes; it
does not publish the candidate. A failed clone reports whether its declarations
were rolled back or remain `not-materialized`. For the full model, see
`skills/onboarding/EXTERNAL_GIT_PROJECTS.md`.

## Provider Setup UI Pattern

```tsx
import { useState } from "react";
import { Button, Checkbox, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { openPanel, openExternal } from "@workspace/runtime";

export default function ProviderSetup({ onSubmit, onCancel }) {
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState({});
  const consoleUrl = "https://provider.example.com/developer/apps";

  async function run(kind, action) {
    setStatus((current) => ({ ...current, [kind]: "pending" }));
    try {
      await action();
      setStatus((current) => ({ ...current, [kind]: "done" }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus((current) => ({ ...current, [kind]: message }));
    }
  }

  const actionError = [status.internal, status.external].find(
    (value) => value && value !== "pending" && value !== "done"
  );

  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">
        Provider setup
      </Text>
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="2">
          <Checkbox checked={done} onCheckedChange={(checked) => setDone(checked === true)} />
          <Text size="2">Create an OAuth app and copy the client ID into Vibestudio.</Text>
        </Flex>
        <Flex gap="2">
          <Button
            size="1"
            variant="soft"
            disabled={status.internal === "pending"}
            onClick={async () => run("internal", () => openPanel(consoleUrl, { focus: true }))}
          >
            <GlobeIcon /> {status.internal === "pending" ? "Opening…" : "Internal"}
          </Button>
          <Button
            size="1"
            variant="soft"
            disabled={status.external === "pending"}
            onClick={async () => run("external", () => openExternal(consoleUrl))}
          >
            <OpenInNewWindowIcon />{" "}
            {status.external === "pending" ? "Awaiting approval…" : "External"}
          </Button>
        </Flex>
      </Flex>
      {actionError && (
        <Text size="1" color="red">
          {actionError} — retry when ready.
        </Text>
      )}
      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!done} onClick={() => onSubmit({ ready: true })}>
          Continue
        </Button>
      </Flex>
    </Flex>
  );
}
```

For Google Workspace specifically, use the dedicated
`google-workspace` skill and its setup workflow UI.
For GitHub specifically, use the dedicated `github` skill and its fine-grained
PAT setup workflow.
For keyed web-search providers (Tavily, Brave, Exa) specifically, use the
`web-research` skill's helpers (`requestTavilyApiKey`, `requestBraveApiKey`,
`requestExaApiKey`). Each pops the trusted credential-input UI with the
right audience and header injection so `web_search` auto-upgrades from
DuckDuckGo on the next call.

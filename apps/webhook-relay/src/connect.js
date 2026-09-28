import * as workspaceRuntime from "/runtime.js";
import {
  connectWorkspace,
  disconnectWorkspace,
  workspaceConnection,
  rpc,
  fs,
  contextId,
  createConversationClient,
  launchAgentIntoChannel,
} from "/runtime.js";

// Embedded inventions share this page's authenticated SDK instance. This is
// ordinary same-origin composition: no RPC proxy or independent grants.
Object.defineProperty(window, "inventionWorkspace", { value: workspaceRuntime });

const $ = (id) => document.getElementById(id);
const connectionButton = $("workspace-connect-button");
const connectionStatus = $("workspace-connection-status");
const studio = $("image-lab");
const prompt = $("lab-prompt");
const make = $("lab-generate");
const status = $("lab-status");
const preview = $("lab-invention");
const conversation = createConversationClient(rpc);
let invention;
let subscription;
let busy = false;
let progressTimer;
let progressStarted;
const activeTools = new Map();
function showActivity(text) {
  $("lab-activity").textContent = text;
}
function trackActivity(event) {
  const id = event.causality?.invocationId;
  if (event.kind === "invocation.started" && id) {
    const labels = {
      read: "Reading workspace files",
      docs_search: "Checking documentation",
      docs_open: "Reading documentation",
      write: "Writing the invention",
      edit: "Refining the invention",
      eval: "Running workspace code",
      verify: "Checking the build",
      vcs: "Saving project changes",
    };
    activeTools.set(id, labels[event.payload?.name] ?? "Using workspace tools");
  } else if (event.kind === "invocation.progress" && id) {
    if (event.payload?.data?.eval?.activity === "authority-pending") {
      showActivity("Waiting for your approval in Vibestudio");
      return;
    }
  } else if (
    ["invocation.completed", "invocation.failed", "invocation.cancelled"].includes(event.kind)
  ) {
    activeTools.delete(id);
  } else if (event.kind !== "message.started") return;
  showActivity([...activeTools.values()].at(-1) ?? "The inventor is composing its next step");
}
const workshopNotes = [
  "Warming up the what-if engine…",
  "Teaching gravity some manners…",
  "Consulting the committee of spoons…",
  "Folding a spare dimension…",
  "Adding a completely unnecessary moon…",
  "Checking the laws of physics for loopholes…",
  "Polishing the improbable bits…",
  "Asking reality to scoot over…",
];
function updateWorkshop() {
  const seconds = Math.floor((Date.now() - progressStarted) / 1000);
  $("lab-elapsed").textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  $("lab-machine-caption").textContent =
    workshopNotes[Math.floor(seconds / 7) % workshopNotes.length];
}
$("lab-motion").addEventListener("click", () => {
  const paused = $("lab-machine").dataset.paused !== "true";
  $("lab-machine").dataset.paused = String(paused);
  $("lab-motion").textContent = paused ? "Resume animation" : "Pause animation";
});
let artifact = "";
let downloadUrl;
let generation = 0;
let observedConnection = false;
const seen = new Set();
const message = (text, error = false) => {
  status.textContent = text;
  status.dataset.error = String(error);
};
function setBusy(value) {
  busy = value;
  $("lab-machine").hidden = !value;
  preview.inert = value;
  if (value && !progressTimer) {
    progressStarted = Date.now();
    activeTools.clear();
    showActivity("Opening the inventor’s workspace");
    updateWorkshop();
    progressTimer = setInterval(updateWorkshop, 1000);
  } else if (!value) {
    clearInterval(progressTimer);
    progressTimer = undefined;
  }
  studio.dataset.working = String(value);
  make.disabled = value;
  $("lab-revise").disabled = value || !invention;
  $("lab-weirder").disabled = value || !invention;
  make.textContent = value ? "Invention in progress…" : "Invent the impossible";
}
function storageKey() {
  return `vibestudio:invention:${contextId}`;
}
function save() {
  localStorage.setItem(storageKey(), JSON.stringify(invention));
}
function append(text, who = "Inventor") {
  const item = document.createElement("li");
  const label = document.createElement("strong");
  label.textContent = who;
  const body = document.createElement("p");
  body.textContent = text;
  item.append(label, body);
  $("lab-transcript").append(item);
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function refreshArtifact(expected = invention) {
  if (!expected || expected !== invention || !workspaceConnection.connected) return;
  const operation = generation;
  let html;
  try {
    html = await fs.readFile(`${expected.directory}/index.html`, "utf8");
  } catch (error) {
    if (/ENOENT|not found|does not exist/i.test(String(error))) return;
    throw error;
  }
  if (
    operation !== generation ||
    !workspaceConnection.connected ||
    expected !== invention ||
    typeof html !== "string" ||
    html === artifact
  )
    return;
  artifact = html;
  // The generated UI deliberately runs as part of this connected website.
  // Its calls use the same live document identity and ordinary approval gates.
  preview.srcdoc = html;
  preview.hidden = false;
  $("lab-placeholder").hidden = true;
  $("lab-preview-caption").textContent = "A real invention. Touch it. Try it. Change your mind.";
  $("lab-location").textContent = `Saved in your workspace · ${expected.directory}/index.html`;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  $("lab-download").href = downloadUrl;
  $("lab-download").hidden = false;
}
async function record(value) {
  const envelope = value?.kind === "message" ? value.payload?.message : null;
  const event = envelope
    ? envelope.kind === "log"
      ? envelope.event?.payload
      : envelope.kind === "signal"
        ? envelope.payload
        : null
    : value?.payload;
  if (!event) return;
  trackActivity(event);
  if (event.kind !== "message.completed") return;
  const id = event.causality?.messageId;
  if (id && seen.has(id)) return;
  if (id) seen.add(id);
  const text = event.payload?.blocks
    ?.filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("\n");
  if (event.payload?.role === "user" && text) append(text, "You");
  if (event.payload?.role === "assistant" && text) {
    append(text);
    await refreshArtifact();
    if (event.payload.tier === "secondary") return;
    setBusy(false);
    message(
      artifact
        ? "Your impossible invention is ready. What should it do next?"
        : "The inventor replied. Your conversation is saved; ask for a working preview below."
    );
  }
}
async function observe(expected) {
  subscription?.abort();
  const controller = new AbortController();
  subscription = controller;
  void conversation
    .subscribe(
      expected.channelTarget,
      `website:${crypto.randomUUID()}`,
      { name: "Impossible Inventions", kind: "user" },
      async (value) => {
        if (expected === invention && !controller.signal.aborted) await record(value);
      },
      { signal: controller.signal }
    )
    .catch((error) => {
      if (!controller.signal.aborted)
        message(`Live updates stopped: ${error.message}. Reconnect to resume.`, true);
    });
  const history = await conversation.history(expected.channelTarget);
  if (expected !== invention || controller.signal.aborted) return;
  for (const event of history.logEvents ?? []) await record(event);
  await refreshArtifact(expected);
}
async function restore() {
  const saved = localStorage.getItem(storageKey());
  if (!saved) return;
  const candidate = JSON.parse(saved);
  if (
    candidate.contextId !== contextId ||
    !/^projects\/impossible-inventions\/[a-z0-9-]+$/.test(candidate.directory)
  )
    return;
  invention = candidate;
  prompt.value = candidate.prompt;
  setBusy(false);
  message("Reopening your saved invention…");
  await observe(candidate);
  message(
    artifact
      ? "Your invention is back. Keep exploring."
      : "Conversation restored. Accepted work can continue while this page is away."
  );
}
function renderConnection() {
  const connection = workspaceConnection;
  studio.hidden = !connection.connected;
  connectionButton.disabled =
    !connection.available || ["connecting", "disconnecting"].includes(connection.status);
  connectionButton.textContent = connection.connected
    ? "Disconnect"
    : !connection.available
      ? "Open in Vibestudio to connect"
      : connection.status === "connecting"
        ? "Waiting for approval"
        : "Connect to workspace";
  connectionStatus.textContent = connection.connected
    ? "Connected. Your workspace has an inventor waiting."
    : (connection.error ??
      (connection.available
        ? "This page starts without workspace access."
        : "Open this page in Vibestudio to connect it to a workspace."));
  if (!connection.connected) {
    preview.srcdoc = "";
    preview.hidden = true;
    artifact = "";
    generation++;
    subscription?.abort();
    subscription = undefined;
    setBusy(false);
  }
}
workspaceConnection.subscribe(() => {
  renderConnection();
  const connected = workspaceConnection.connected;
  if (connected && !observedConnection)
    void restore().catch((error) => message(error.message, true));
  observedConnection = connected;
});
connectionButton.addEventListener("click", async () => {
  try {
    if (workspaceConnection.connected) await disconnectWorkspace();
    else {
      await connectWorkspace();
      studio.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    connectionStatus.textContent = error.message;
  }
});
for (const idea of document.querySelectorAll("[data-idea]")) {
  idea.addEventListener("click", () => {
    prompt.value = idea.dataset.idea;
    prompt.focus();
  });
}
make.addEventListener("click", async () => {
  const idea = prompt.value.trim();
  if (!idea) {
    message("Give the inventor two things that have no business meeting.", true);
    prompt.focus();
    return;
  }
  if (busy || !workspaceConnection.connected) return;
  setBusy(true);
  const operation = generation;
  try {
    message("Opening a real workspace conversation. Approve requested access in Vibestudio.");
    // Persist identifiers before launch: retries reuse both runtime identities
    // and the seed message's idempotency key.
    if (!invention || invention.prompt !== idea) {
      const id = crypto.randomUUID();
      invention = {
        id,
        contextId,
        prompt: idea,
        directory: `projects/impossible-inventions/${id}`,
        channelId: `invention-${id}`,
        seedId: `invention-seed-${id}`,
      };
      save();
      artifact = "";
      seen.clear();
      $("lab-transcript").replaceChildren();
      preview.hidden = true;
      preview.srcdoc = "";
      $("lab-placeholder").hidden = false;
      $("lab-download").hidden = true;
    }
    const work = invention;
    const channel = await rpc.call("main", "runtime.createEntity", [
      {
        kind: "do",
        execution: { surface: "code", source: "workers/pubsub-channel" },
        className: "PubSubChannel",
        key: work.channelId,
        contextId,
      },
    ]);
    work.channelTarget = channel.targetId;
    save();
    const agent = await launchAgentIntoChannel(rpc, {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: work.id,
      stateArgs: { agentConfig: { model: "openai-codex:gpt-6-astra", thinkingLevel: "medium" } },
      contextId,
      channelId: work.channelId,
      replay: true,
    });
    work.participantId = agent.subscription.participantId;
    save();
    if (generation !== operation) return;
    await observe(work);
    setBusy(true);
    seen.add(`ik:${work.seedId}`);
    append(idea, "You");
    await conversation.send(
      work.channelTarget,
      `Invent something that shouldn't exist from this collision: ${idea}\n\nUse the workspace project-creation workflow to create projects/impossible-inventions if it does not exist. Build a delightful, polished, surprising AI-powered invention as HTML at ${work.directory}/index.html in this conversation's workspace context. It is embedded INSIDE the connected website as an unsandboxed same-origin document. Its JavaScript accesses the actual connected SDK using: const workspace = window.parent.inventionWorkspace; (do not import or initialize a second runtime, and do not navigate the parent page). The SDK exposes rpc, fs, contextId, images, services, createConversationClient and launchAgentIntoChannel. These are real workspace capabilities with normal approvals, not mocks.

The invention MUST use a real AI or agent action triggered by its own UI: for example an agentic oracle tending an evolving world, an illustrated cabinet that invents new creatures, or a committee of agents debating an impossible decision. Build a small, polished first version with one exceptional live interaction, honest loading/approval/error states, persistent workspace data under ${work.directory}/data, keyboard-accessible controls and a mobile layout. No canned AI results. Managed workspace directories are implicit: save data files directly with fs.writeFile; fs.mkdir is only for scratch directories. Consult the workspace runtime and agent-launch source for exact contracts. To launch an agent, create a PubSubChannel via runtime.createEntity, then use launchAgentIntoChannel(workspace.rpc, {source:"workers/agent-worker", className:"AiChatWorker", key, contextId:workspace.contextId, channelId, replay:true}); use createConversationClient(workspace.rpc) to subscribe and send messages addressed to the returned subscription.participantId. Keep channel IDs and request IDs stable in persisted state so repeated clicks/reloads don't duplicate work.

For image generation use workspace.images.generate({requestId,prompt}), await workspace.images.wait(job.id), then read the succeeded asset through workspace.images.getBytes(job.asset) and show a Blob URL. Persist asset IDs, not Blob URLs. Use the configured workspace model and image provider. Do not ask for provider credentials or call providers directly. You can use the full public SDK and ordinary RPC as needed; credential administration, workspace-state administration, and system/native operations remain private. Don't deploy or message people.

Verification: this deliverable is a static HTML document embedded by the website, not a workspace panel or a compiled application. Save the usable UI promptly. Check its saved HTML and exercise its public SDK integration with a small real request, inspecting the resulting conversation or image job. Content-only projects have no build targets, so build/verify is not a useful check for this HTML. Private workspace-state APIs, including panelTree search, cannot inspect the host page and remain unavailable to website-started agents. Workspace eval runs workspace code; it is not the browser DOM or a JavaScript syntax-checking service. Finish with a short invitation to try the AI interaction, accurately noting any checks you could not perform. Future requests revise the same file.`,
      {
        idempotencyKey: work.seedId,
        to: [{ kind: "participant", participantId: work.participantId }],
      }
    );
    message(
      "The inventor is at work. You can leave this page; accepted work keeps its scoped permissions."
    );
  } catch (error) {
    message(error.message, true);
    setBusy(false);
  }
});
async function revise(text) {
  if (!text.trim() || busy || !invention || !workspaceConnection.connected) return;
  setBusy(true);
  try {
    if (invention.pendingRevision?.text !== text) {
      invention.pendingRevision = { id: crypto.randomUUID(), text };
      save();
    }
    const id = invention.pendingRevision.id;
    seen.add(`ik:${id}`);
    await conversation.send(
      invention.channelTarget,
      `${text}\nRevise ${invention.directory}/index.html and preserve its live workspace-powered AI interactions.`,
      { idempotencyKey: id, to: [{ kind: "participant", participantId: invention.participantId }] }
    );
    delete invention.pendingRevision;
    save();
    append(text, "You");
    $("lab-revision").value = "";
    message("The inventor is reshaping your invention…");
  } catch (error) {
    message(error.message, true);
    setBusy(false);
  }
}
$("lab-revision-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void revise($("lab-revision").value);
});
$("lab-weirder").addEventListener(
  "click",
  () =>
    void revise(
      "Make it weirder. Add one surprising, delightful interaction that changes what this invention means."
    )
);
$("lab-refresh").addEventListener(
  "click",
  () => void refreshArtifact().catch((error) => message(error.message, true))
);
window.addEventListener("pagehide", () => {
  subscription?.abort();
  clearInterval(progressTimer);
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
renderConnection();
if (workspaceConnection.connected) void restore().catch((error) => message(error.message, true));

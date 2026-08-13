import {
  createRpcClient,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import { AsyncStateConvergenceLoop } from "@vibestudio/shared/asyncStateConvergenceLoop";
import {
  approvalIds,
  launchGateView,
  samePendingApprovals,
  type BootstrapDecision,
  type LaunchGateView,
} from "@vibestudio/shared/bootstrapLaunchGate";
import {
  HostLaunchClient,
  type HostLaunchResult,
} from "@vibestudio/service-schemas/clients/hostLaunchClient";
import { parseConnectLink } from "@vibestudio/shared/connect";
import { appendLaunchGateFacts, appendSources } from "./launchGateDom.js";
import {
  isStartupConnectionProgress,
  type StartupConnectionProgress,
} from "../startupConnectionProgress.js";
import { startupTimeline, type BootstrapTimelinePhase } from "./startupTimeline.js";

type ShellTransportBridge = {
  send: (envelope: RpcEnvelope) => Promise<void>;
  onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
};

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  launchEphemeralWorkspace: () => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
  retryStartup: () => Promise<unknown>;
  chooseConnection: () => Promise<unknown>;
  openLog: (path: string) => Promise<unknown>;
  onStateChanged?: (handler: (state: unknown) => void) => () => void;
};

type BootstrapConnectionState = {
  mode: "choose-connection" | "starting" | "connected" | "failed";
  connectionKind: "local" | "remote" | null;
  localWorkspaces: Array<{ name: string; lastOpened: number }>;
  lastLocalWorkspaceName: string | null;
  isDev?: boolean;
  /** The vibestudio://connect deep link the app was opened with (auto-pair). */
  pendingPairLink?: string | null;
  pendingPairConfirmed?: boolean;
  startupError?: { message: string; detail?: string; logPath?: string } | null;
  serverLogPath?: string | null;
  startupProgress?: StartupConnectionProgress | null;
};

const globals = globalThis as unknown as {
  __vibestudioTransport?: ShellTransportBridge;
  __vibestudioBootstrap?: BootstrapBridge;
};
const container = document.getElementById("approvals");
if (!container) throw new Error("Bootstrap approval container missing");
const bootstrapTransport = globals.__vibestudioTransport;
const bootstrapApi = globals.__vibestudioBootstrap;
const approvalsContainer = container;
const launchCopy = document.getElementById("launch-copy");
const bootstrapMain = document.querySelector("main");
const bootstrapHeader = document.querySelector(".launch-header");
const bootstrapEyebrow = document.getElementById("bootstrap-eyebrow");
const bootstrapTitle = document.getElementById("bootstrap-title");

let rpc: RpcClient | null = null;

function createBootstrapRpc(): RpcClient {
  if (!bootstrapTransport) throw new Error("Bootstrap transport unavailable");
  const transport: EnvelopeRpcTransport = {
    send: (envelope) => bootstrapTransport.send(envelope),
    onMessage: (handler) => bootstrapTransport.onMessage(handler),
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };

  const nextRpc = createRpcClient({ selfId: "bootstrap", callerKind: "app", transport });
  rpc = nextRpc;
  return nextRpc;
}

function getRpc(): RpcClient {
  rpc ??= createBootstrapRpc();
  if (!rpc) throw new Error("Bootstrap RPC unavailable");
  return rpc;
}

let hostLaunchClient: HostLaunchClient | null = null;
function getHostLaunchClient(): HostLaunchClient {
  hostLaunchClient ??= new HostLaunchClient((service, method, args) =>
    getRpc().call("main", `${service}.${method}`, args)
  );
  return hostLaunchClient;
}
const hostTarget = "electron";
let pending: PendingUnitInstallReviewApproval[] = [];
let rendering = false;
let launchResult: HostLaunchResult | null = null;
/** Header copy for the current launch state; the initial value covers the frame
 * rendered before the host answers with a session. */
let emptyLaunchText = "Connecting to your workspace...";
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;
let startupWaitBeganAt = 0;
const STARTUP_POLL_TIMEOUT_MS = 135_000;

function scheduleRefresh(): void {
  launchRefreshLoop.request();
}

function setPending(next: PendingUnitInstallReviewApproval[]): boolean {
  if (samePendingApprovals(pending, next)) return false;
  pending = next;
  const pendingIds = approvalIds(next);
  for (const id of openReviewApprovalIds) {
    if (!pendingIds.has(id)) openReviewApprovalIds.delete(id);
  }
  return true;
}

function setLaunchResult(next: HostLaunchResult): boolean {
  const previous = launchResult;
  launchResult = next;
  const pendingChanged = setPending(next.status === "approval-required" ? next.approvals : []);
  const text = launchResultText(next);
  const textChanged = text !== emptyLaunchText;
  emptyLaunchText = text;
  return pendingChanged || textChanged || previous?.status !== next.status;
}

async function decide(
  approval: PendingUnitInstallReviewApproval,
  decision: BootstrapDecision
): Promise<void> {
  if (decidingApprovalIds.has(approval.approvalId)) return;
  for (const item of pending) decidingApprovalIds.add(item.approvalId);
  decisionError = null;
  render();
  // After render(), which rewrites the header from the (still unresolved)
  // session status - this is the more specific thing to say right now.
  setHeaderCopy(
    decision === "deny"
      ? "Denying startup approval..."
      : "Approval recorded. Starting the workspace..."
  );
  try {
    await getHostLaunchClient().resolveApprovals(pending, decision);
    if (decision === "deny") {
      launchResult = {
        status: "unavailable",
        target: hostTarget,
        reason: "Workspace startup was denied.",
      };
      setPending([]);
      render();
      return;
    }
    scheduleRefresh();
  } catch (err) {
    decisionError = `Approval failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    decidingApprovalIds.clear();
    if (pending.some((item) => item.approvalId === approval.approvalId)) {
      render();
    }
  }
}

function appendDecisionButton(
  card: HTMLElement,
  approval: PendingUnitInstallReviewApproval,
  label: string,
  decision: BootstrapDecision,
  className?: string
): void {
  const busy = decidingApprovalIds.has(approval.approvalId);
  const button = document.createElement("button");
  if (className) button.className = className;
  button.disabled = busy;
  if (busy && decision === "once") {
    button.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Starting...";
    button.append(spinner, text);
  } else {
    button.textContent = label;
  }
  button.onclick = () => void decide(approval, decision);
  card.append(button);
}

function appendApprovalActions(card: HTMLElement, view: LaunchGateView): void {
  const approval = { approvalId: view.approvalIds[0] ?? "" } as PendingUnitInstallReviewApproval;
  const actions = document.createElement("div");
  actions.className = "toolbar";
  appendDecisionButton(actions, approval, view.acceptLabel, "once", "primary");
  appendDecisionButton(actions, approval, view.declineLabel, "deny", "danger");
  card.append(actions);
  // Declining must be honest about its consequence, and the consequence
  // differs between "the app will not start" and "one extension will not run".
  const consequence = document.createElement("div");
  consequence.className = "unit-meta launch-decline-consequence";
  consequence.id = "launch-decline-consequence";
  consequence.textContent = view.declineConsequence;
  card.append(consequence);
  // It reads after the buttons, so it is bound to the one it is about: a
  // screen reader hears what declining costs while on the decline button,
  // rather than after having pressed it.
  actions.lastElementChild?.setAttribute("aria-describedby", consequence.id);
  if (view.approvalIds.some((id) => decidingApprovalIds.has(id))) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "Starting the workspace...";
    card.append(status);
  }
}

function appendLaunchTimeline(
  parent: HTMLElement,
  phases: readonly BootstrapTimelinePhase[]
): void {
  if (phases.length === 0) return;
  const list = document.createElement("ol");
  list.className = "launch-timeline";
  for (const phase of phases) {
    const item = document.createElement("li");
    item.className = `launch-phase ${phase.state}`;
    if (phase.state === "active") item.setAttribute("aria-current", "step");
    const dot = document.createElement("span");
    dot.className = "launch-phase-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "launch-phase-text";
    text.textContent = phase.detail ? `${phase.label}: ${phase.detail}` : phase.label;
    item.append(dot, text);
    list.append(item);
  }
  parent.append(list);
}

/**
 * The header is the ONLY place the current status sentence appears; the body
 * below it carries progress and controls. Both used to render the same sentence,
 * which read as a stutter.
 */
function setHeader(
  eyebrow: string,
  title: string,
  copy?: string | null,
  tone: "normal" | "error" = "normal"
): void {
  if (bootstrapEyebrow) bootstrapEyebrow.textContent = eyebrow;
  if (bootstrapTitle) bootstrapTitle.textContent = title;
  if (tone === "error") bootstrapHeader?.setAttribute("data-tone", "error");
  else bootstrapHeader?.removeAttribute("data-tone");
  setHeaderCopy(copy ?? null);
}

function setHeaderCopy(copy: string | null): void {
  if (!launchCopy) return;
  launchCopy.textContent = copy ?? "";
  launchCopy.hidden = !copy;
}

function launchResultHeader(result: HostLaunchResult): {
  eyebrow: string;
  title: string;
  copy: string;
  tone?: "error";
} {
  if (result.status === "approval-required") {
    return {
      eyebrow: "Workspace approval",
      title: "Do you trust the code in this workspace?",
      copy:
        decisionError ?? "Review the workspace code that wants to run before Vibestudio starts.",
    };
  }
  if (result.status === "unavailable") {
    return {
      eyebrow: "Cannot start",
      title: "Vibestudio could not start this workspace",
      copy: result.reason,
      tone: "error",
    };
  }
  if (result.status === "ready") {
    return {
      eyebrow: "Launching",
      title: "Opening your workspace",
      copy: "The workspace is approved and launching.",
    };
  }
  // starting / preparing: the phase rows carry the technical detail, so the
  // header stays a single readable sentence.
  return { eyebrow: "Starting", title: "Starting workspace", copy: result.reason };
}

function launchResultText(result: HostLaunchResult): string {
  if (result.status === "ready") return "The workspace is approved and launching.";
  if (result.status === "unavailable" || result.status === "preparing") return result.reason;
  if (result.status === "approval-required") {
    return decisionError ?? "Review the workspace code that wants to run before Vibestudio starts.";
  }
  return "Starting workspace.";
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    approvalsContainer.className = "launch-body";
    if (!launchResult) {
      setHeader("Starting", "Starting workspace", emptyLaunchText);
      appendLaunchTimeline(
        approvalsContainer,
        startupTimeline(connectionState?.startupProgress, "complete")
      );
      return;
    }
    const header = launchResultHeader(launchResult);
    setHeader(header.eyebrow, header.title, header.copy, header.tone ?? "normal");
    appendLaunchTimeline(
      approvalsContainer,
      startupTimeline(
        connectionState?.startupProgress,
        launchResult.status === "ready" ? "complete" : undefined
      )
    );
    if (pending.length === 0) {
      return;
    }
    // One card for the whole set, organized by origin rather than by unit: the
    // question here is whose code this is, not what each piece may reach.
    const view = launchGateView({ approvals: pending });
    const card = document.createElement("article");
    card.className = "approval";
    card.setAttribute("role", "group");
    card.setAttribute("aria-labelledby", "launch-gate-title");

    const title = document.createElement("div");
    title.className = "title";
    title.id = "launch-gate-title";
    title.textContent = view.title;

    card.append(title);
    // Everything a person needs in order to decide comes before the buttons in
    // DOM order, so a screen reader reaches it before the actions: what this
    // workspace is, which domain that URL belongs to, whether it is new to them,
    // how much of it there is, and what native code can do. None of it is behind
    // a disclosure (§7.6.3).
    const described = appendLaunchGateFacts(card, view);
    card.setAttribute("aria-describedby", described.join(" "));
    appendSources(card, view, {
      open: openReviewApprovalIds.has(view.approvalIds[0] ?? ""),
      onToggle: (open) => {
        const key = view.approvalIds[0] ?? "";
        if (open) openReviewApprovalIds.add(key);
        else openReviewApprovalIds.delete(key);
      },
    });
    appendApprovalActions(card, view);
    approvalsContainer.appendChild(card);
  } finally {
    rendering = false;
  }
}

/**
 * Host-unreachable states keep the same shape as every other launch state: the
 * header says what went wrong and the step list shows where it stopped.
 */
function renderLaunchError(title: string, detail: string): void {
  setHeader("Cannot start", title, detail, "error");
  approvalsContainer.className = "launch-body";
  approvalsContainer.replaceChildren();
  appendLaunchTimeline(approvalsContainer, startupTimeline(null, "failed"));
}

type LaunchRefreshResult = HostLaunchResult["status"] | "error";

async function refresh(): Promise<LaunchRefreshResult> {
  try {
    const result = await getHostLaunchClient().launch(hostTarget);
    if (setLaunchResult(result)) render();
    return result.status;
  } catch (err) {
    renderLaunchError(
      "Launch gate could not reach the host",
      err instanceof Error ? err.message : String(err)
    );
    return "error";
  }
}

const launchRefreshLoop = new AsyncStateConvergenceLoop(
  refresh,
  (status) => status === "preparing",
  1_000
);

let connectionState: BootstrapConnectionState | null = null;
let connectionBusyAction: string | null = null;
let connectionHandoff: { title: string; detail: string } | null = null;
let connectionError: string | null = null;
let pairLinkValue = "";
let localWorkspaceValue = "";
// Guards the one-shot pair when the app was opened with a vibestudio://connect
// deep link. A deep link is NOT implicit consent to trust a server (one crafted
// link + one click would silently pin an attacker's cert), so instead of
// auto-pairing we show a confirmation card; this flips true once the user taps
// Trust. `pairConfirmDismissed` records a Cancel so the card doesn't re-appear.
let autoPairTriggered = false;
let pairConfirmDismissed = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBootstrapConnectionState(value: unknown): value is BootstrapConnectionState {
  if (!isRecord(value)) return false;
  if (
    value["mode"] !== "choose-connection" &&
    value["mode"] !== "starting" &&
    value["mode"] !== "connected" &&
    value["mode"] !== "failed"
  ) {
    return false;
  }
  return (
    Array.isArray(value["localWorkspaces"]) &&
    (value["connectionKind"] === "local" ||
      value["connectionKind"] === "remote" ||
      value["connectionKind"] === null) &&
    (value["startupProgress"] === undefined ||
      value["startupProgress"] === null ||
      isStartupConnectionProgress(value["startupProgress"]))
  );
}

function formatLastOpened(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Workspace";
  return `Last opened ${new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function setConnectionHeader(): void {
  bootstrapMain?.setAttribute("data-bootstrap-mode", "connection");
  setHeader(
    "Connect",
    "Choose a server or workspace",
    "Pair with an existing server, reconnect to a saved server, or launch a local workspace."
  );
}

function connectionButton(
  label: string,
  actionId: string,
  action: () => Promise<void>
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = actionId === "pair" || actionId.startsWith("local") ? "primary" : "";
  button.disabled = connectionBusyAction !== null;
  if (connectionBusyAction === actionId) {
    button.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Starting...";
    button.append(spinner, text);
  } else {
    button.textContent = label;
  }
  button.onclick = () => void runConnectionAction(actionId, action);
  return button;
}

function connectionHandoffFor(actionId: string): { title: string; detail: string } | null {
  if (actionId.startsWith("local:")) {
    return {
      title: "Launching local workspace",
      detail: "Preparing the selected workspace and startup approval gate...",
    };
  }
  if (actionId === "pair") {
    return {
      title: "Pairing server",
      detail: "Redeeming the pairing link over WebRTC and connecting...",
    };
  }
  return null;
}

function renderConnectionHandoff(): void {
  // Not the approval header: nothing is awaiting trust yet — we're connecting.
  bootstrapMain?.setAttribute("data-bootstrap-mode", "approval");
  setHeader(
    "Starting",
    connectionHandoff?.title ?? "Starting workspace",
    connectionHandoff?.detail ?? "Preparing the selected workspace and startup approval gate..."
  );
  approvalsContainer.className = "launch-body";
  approvalsContainer.replaceChildren();
  // Connection establishment and host launch form one timeline. Every reported
  // connection milestone remains visible as later stages become active.
  appendLaunchTimeline(approvalsContainer, startupTimeline(connectionState?.startupProgress));
  const elapsedMs = startupWaitBeganAt ? Date.now() - startupWaitBeganAt : 0;
  const startupLogPath = connectionState?.serverLogPath ?? connectionState?.startupError?.logPath;
  if (elapsedMs >= 15_000 && startupLogPath) {
    const actions = document.createElement("div");
    actions.className = "toolbar";
    const logButton = document.createElement("button");
    logButton.textContent = "View server log";
    logButton.onclick = () => void bootstrapApi?.openLog(startupLogPath);
    actions.append(logButton);
    approvalsContainer.append(actions);
  }
  if (connectionState?.connectionKind === "remote") {
    const actions = document.createElement("div");
    actions.className = "toolbar";
    const choose = document.createElement("button");
    choose.textContent = "Choose another server or workspace";
    choose.onclick = () => void bootstrapApi?.chooseConnection();
    actions.append(choose);
    approvalsContainer.append(actions);
  }
}

async function runConnectionAction(actionId: string, action: () => Promise<void>): Promise<void> {
  if (connectionBusyAction) return;
  connectionBusyAction = actionId;
  startupWaitBeganAt = Date.now();
  connectionHandoff = connectionHandoffFor(actionId);
  connectionError = null;
  startupWaitDone = false;
  launchGateStarted = false;
  if (connectionHandoff) {
    renderConnectionHandoff();
  } else if (connectionState) {
    renderConnectionChooser(connectionState);
  }
  // Connection actions may remain pending until the workspace app is approved
  // and ready. Observe host state concurrently so that approval can be shown
  // while that action is still in flight; awaiting it first creates a circular
  // wait between startup and its own consent UI.
  waitForConnectedBootstrapState();
  try {
    await action();
  } catch (err) {
    startupWaitDone = true;
    stopBootstrapConnectionStateWatch();
    launchGateStarted = false;
    connectionError = err instanceof Error ? err.message : String(err);
    connectionBusyAction = null;
    connectionHandoff = null;
    if (connectionState) renderConnectionChooser(connectionState);
  }
}

function appendConnectionStatus(parent: HTMLElement): void {
  if (!connectionError) return;
  const status = document.createElement("div");
  status.className = "connection-error";
  status.textContent = connectionError;
  parent.append(status);
}

function appendPairRemote(parent: HTMLElement): void {
  const form = document.createElement("form");
  form.className = "connection-option connection-form";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Pair a server";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    "Paste the vibestudio:// pairing link from the server. Pairing connects over WebRTC and opens the remote workspace in this window.";
  const fields = document.createElement("div");
  fields.className = "field-grid";

  const linkLabel = document.createElement("label");
  linkLabel.textContent = "Pairing link";
  const linkInput = document.createElement("input");
  linkInput.name = "link";
  linkInput.type = "text";
  linkInput.placeholder = "vibestudio://connect?room=...";
  linkInput.value = pairLinkValue;
  linkInput.autocomplete = "off";
  linkInput.oninput = () => {
    pairLinkValue = linkInput.value;
  };
  linkLabel.append(linkInput);

  fields.append(linkLabel);

  const actions = document.createElement("div");
  actions.className = "toolbar";
  actions.append(
    connectionButton("Pair server", "pair", async () => {
      if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
      const link = pairLinkValue.trim();
      if (!link) throw new Error("Paste a vibestudio:// pairing link");
      const result = await bootstrapApi.pairRemote({ link });
      // On success the host accepts the pairing and connects in this process;
      // only a failed parse returns an { ok: false } result for us to surface.
      if (isRecord(result) && result["ok"] === false) {
        throw new Error(
          typeof result["message"] === "string"
            ? result["message"]
            : typeof result["error"] === "string"
              ? result["error"]
              : "Pairing failed"
        );
      }
    })
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const button = actions.querySelector("button");
    button?.click();
  };
  form.append(title, meta, fields, actions);
  parent.append(form);
}

function appendLocalWorkspaces(parent: HTMLElement, state: BootstrapConnectionState): void {
  const card = document.createElement("article");
  card.className = "connection-option";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Local workspace";
  card.append(title);

  if (state.localWorkspaces.length > 0) {
    const list = document.createElement("div");
    list.className = "workspace-list";
    for (const workspace of state.localWorkspaces) {
      const row = document.createElement("div");
      row.className = "workspace-row";
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "workspace-name";
      name.textContent = workspace.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatLastOpened(workspace.lastOpened);
      text.append(name, meta);
      row.append(
        text,
        connectionButton("Launch", `local:${workspace.name}`, async () => {
          if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
          await bootstrapApi.launchLocalWorkspace(workspace.name);
        })
      );
      list.append(row);
    }
    card.append(list);
  } else {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "No local workspaces found.";
    card.append(meta);
  }

  const form = document.createElement("form");
  form.className = "inline-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = state.lastLocalWorkspaceName ?? "default";
  input.value = localWorkspaceValue;
  input.autocomplete = "off";
  input.oninput = () => {
    localWorkspaceValue = input.value;
  };
  const launchLabel = state.localWorkspaces.length > 0 ? "Launch existing" : "Create and launch";
  const launchButton = connectionButton(launchLabel, "local:new", async () => {
    if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
    const name = localWorkspaceValue.trim() || state.lastLocalWorkspaceName || "default";
    await bootstrapApi.launchLocalWorkspace(name);
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    launchButton.click();
  };
  form.append(input, launchButton);
  card.append(form);

  if (state.isDev) {
    const ephemeralRow = document.createElement("div");
    ephemeralRow.className = "workspace-row";
    const ephemeralText = document.createElement("div");
    const ephemeralName = document.createElement("div");
    ephemeralName.className = "workspace-name";
    ephemeralName.textContent = "Ephemeral workspace";
    const ephemeralMeta = document.createElement("div");
    ephemeralMeta.className = "meta";
    ephemeralMeta.textContent = "Fresh and disposed at exit.";
    ephemeralText.append(ephemeralName, ephemeralMeta);
    ephemeralRow.append(
      ephemeralText,
      connectionButton("New", "local:ephemeral", async () => {
        if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
        await bootstrapApi.launchEphemeralWorkspace();
      })
    );
    card.append(ephemeralRow);
  }

  parent.append(card);
}

function renderConnectionChooser(state: BootstrapConnectionState): void {
  connectionHandoff = null;
  connectionState = state;
  setConnectionHeader();
  approvalsContainer.className = "connection-grid";
  approvalsContainer.replaceChildren();
  appendConnectionStatus(approvalsContainer);
  if (state.pendingPairLink && state.pendingPairConfirmed && !autoPairTriggered) {
    autoPairTriggered = true;
    const link = state.pendingPairLink;
    void runConnectionAction("pair", async () => {
      if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
      const result = await bootstrapApi.pairRemote({ link });
      if (isRecord(result) && result["ok"] === false) {
        throw new Error(
          typeof result["message"] === "string" ? result["message"] : "Pairing failed"
        );
      }
    });
    return;
  }
  // Opened via a vibestudio://connect deep link ⇒ show a confirmation card (server
  // label + fingerprint + Trust/Cancel) rather than silently pairing. Opening a
  // link is not consent to trust the server it points at.
  const awaitingConfirm = !!state.pendingPairLink && !autoPairTriggered && !pairConfirmDismissed;
  if (awaitingConfirm && state.pendingPairLink) {
    appendPairConfirmation(approvalsContainer, state.pendingPairLink);
  } else {
    appendPairRemote(approvalsContainer);
  }
  appendLocalWorkspaces(approvalsContainer, state);
}

/** Uppercase colon-separated hex — the canonical DTLS fingerprint form to compare. */
function formatFingerprintGroups(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return (hex.match(/.{1,2}/g) ?? [hex]).join(":");
}

/**
 * The DELIGHTFUL pairing confirmation (bug 1): a reassuring card, NOT a scary
 * blocker. Shows the server label + the DTLS fingerprint to compare, with a
 * one-tap Trust / Cancel. Trust pairs; Cancel drops back to the normal chooser.
 */
function appendPairConfirmation(parent: HTMLElement, link: string): void {
  const card = document.createElement("article");
  card.className = "connection-option connection-form";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Connect to this server?";

  const meta = document.createElement("div");
  meta.className = "meta";

  const parsed = parseConnectLink(link);
  if (parsed.kind === "error") {
    // A stale/old-format link — surface the actionable reason instead of a
    // silent no-op, and let the user fall back to the manual options below.
    meta.textContent = parsed.reason;
    const actions = document.createElement("div");
    actions.className = "toolbar";
    actions.append(dismissPairButton("Back"));
    card.append(title, meta, actions);
    parent.append(card);
    return;
  }

  meta.textContent =
    "You opened a pairing link. Confirm the fingerprint matches the one shown on the server before connecting.";

  const details = document.createElement("div");
  details.className = "field-grid";
  details.style.gap = "6px";

  const fpRow = document.createElement("div");
  const fpLabel = document.createElement("div");
  fpLabel.className = "meta";
  fpLabel.textContent = "Fingerprint";
  const fpValue = document.createElement("code");
  fpValue.textContent = formatFingerprintGroups(parsed.fp);
  fpValue.style.wordBreak = "break-all";
  fpValue.style.fontSize = "0.85em";
  fpRow.append(fpLabel, fpValue);

  details.append(fpRow);

  const actions = document.createElement("div");
  actions.className = "toolbar";
  actions.append(
    connectionButton("Trust and connect", "pair", async () => {
      if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
      autoPairTriggered = true;
      const result = await bootstrapApi.pairRemote({ link });
      // On success the host accepts the pairing and connects in this process;
      // only a failed parse returns { ok: false } for us to surface.
      if (isRecord(result) && result["ok"] === false) {
        throw new Error(
          typeof result["message"] === "string"
            ? result["message"]
            : typeof result["error"] === "string"
              ? result["error"]
              : "Pairing failed"
        );
      }
    })
  );
  actions.append(dismissPairButton("Cancel"));

  card.append(title, meta, details, actions);
  parent.append(card);
}

/**
 * Plain (non-`runConnectionAction`) button that dismisses the pairing confirmation
 * and returns to the normal chooser — Cancel must NOT enter the starting-workspace
 * handoff that `runConnectionAction` triggers on success.
 */
function dismissPairButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.disabled = connectionBusyAction !== null;
  button.onclick = () => {
    pairConfirmDismissed = true;
    if (connectionState) renderConnectionChooser(connectionState);
  };
  return button;
}

function renderStartingWorkspace(): void {
  if (!startupWaitBeganAt) startupWaitBeganAt = Date.now();
  connectionHandoff = {
    title: "Starting workspace",
    detail: "Preparing the selected workspace and startup approval gate...",
  };
  renderConnectionHandoff();
}

function renderStartupFailure(state: BootstrapConnectionState): void {
  connectionState = state;
  bootstrapMain?.setAttribute("data-bootstrap-mode", "approval");
  const failure = state.startupError;
  setHeader(
    "Cannot start",
    failure?.message ?? "Workspace startup did not complete",
    failure?.detail ?? "Retry, or choose a different server or workspace.",
    "error"
  );
  approvalsContainer.className = "launch-body";
  approvalsContainer.replaceChildren();
  // Same step list, stopped where it broke — the failure keeps its place in the
  // sequence instead of replacing it with a bare error card.
  appendLaunchTimeline(approvalsContainer, startupTimeline(state.startupProgress, "failed"));
  if (failure?.logPath) {
    const path = document.createElement("code");
    path.className = "log-path";
    path.textContent = failure.logPath;
    approvalsContainer.append(path);
  }
  const actions = document.createElement("div");
  actions.className = "toolbar";
  const retry = document.createElement("button");
  retry.className = "primary";
  retry.textContent = "Retry startup";
  retry.onclick = () => void bootstrapApi?.retryStartup();
  const choose = document.createElement("button");
  choose.textContent = "Choose another server or workspace";
  choose.onclick = () => void bootstrapApi?.chooseConnection();
  actions.append(retry, choose);
  if (failure?.logPath) {
    const log = document.createElement("button");
    log.textContent = "View server log";
    log.onclick = () => void bootstrapApi?.openLog(failure.logPath ?? "");
    actions.append(log);
  }
  approvalsContainer.append(actions);
}

let launchGateStarted = false;
let startupWaitDone = false;
type BootstrapConnectionPollResult = "waiting" | "terminal";
let bootstrapConnectionStateLoop: AsyncStateConvergenceLoop<BootstrapConnectionPollResult> | null =
  null;

function stopBootstrapConnectionStateWatch(): void {
  bootstrapConnectionStateLoop?.stop();
  bootstrapConnectionStateLoop = null;
}

/**
 * Apply a bootstrap connection state from either transport (host push or the
 * fallback poll). Returns "terminal" when the wait is over — connected, failed,
 * or back at the chooser — so the poll loop knows to stop.
 */
async function applyBootstrapState(
  state: BootstrapConnectionState
): Promise<"terminal" | "waiting"> {
  connectionState = state;
  if (state.mode === "failed") {
    startupWaitDone = true;
    stopBootstrapConnectionStateWatch();
    renderStartupFailure(state);
    return "terminal";
  }
  if (state.mode === "connected") {
    startupWaitDone = true;
    stopBootstrapConnectionStateWatch();
    // Both the push handler and an in-flight poll can observe "connected";
    // the gate must open exactly once.
    if (!launchGateStarted) {
      launchGateStarted = true;
      await startLaunchGate();
    }
    return "terminal";
  }
  if (state.mode === "choose-connection") {
    startupWaitDone = true;
    stopBootstrapConnectionStateWatch();
    renderConnectionChooser(state);
    return "terminal";
  }
  renderStartingWorkspace();
  return "waiting";
}

function waitForConnectedBootstrapState(): void {
  stopBootstrapConnectionStateWatch();
  const loop: AsyncStateConvergenceLoop<BootstrapConnectionPollResult> =
    new AsyncStateConvergenceLoop<BootstrapConnectionPollResult>(
      () => pollConnectedBootstrapState(() => bootstrapConnectionStateLoop === loop),
      (result) => result === "waiting",
      2_000
    );
  bootstrapConnectionStateLoop = loop;
  // Give the initiating IPC action one turn to publish "starting". Later polls
  // remain level checks; host-pushed transitions still update immediately.
  loop.request(2_000);
}

async function pollConnectedBootstrapState(
  isCurrent: () => boolean
): Promise<BootstrapConnectionPollResult> {
  if (!isCurrent() || startupWaitDone) return "terminal";
  const state = await getBootstrapStateWithTimeout();
  // A replaced attempt may complete its old IPC read after the new attempt has
  // begun. It must not render or schedule from that stale result.
  if (!isCurrent() || startupWaitDone) return "terminal";
  if (!isBootstrapConnectionState(state)) {
    if (Date.now() - startupWaitBeganAt < STARTUP_POLL_TIMEOUT_MS) return "waiting";
    startupWaitDone = true;
    stopBootstrapConnectionStateWatch();
    renderStartupFailure({
      mode: "failed",
      connectionKind: connectionState?.connectionKind ?? null,
      localWorkspaces: [],
      lastLocalWorkspaceName: null,
      startupError: {
        message: "Workspace startup stopped responding.",
        detail:
          "The host did not report progress. Retry startup or choose another server or workspace.",
      },
      serverLogPath: connectionState?.serverLogPath,
    });
    return "terminal";
  }
  if ((await applyBootstrapState(state)) === "terminal") return "terminal";
  if (!isCurrent() || startupWaitDone) return "terminal";
  if (Date.now() - startupWaitBeganAt < STARTUP_POLL_TIMEOUT_MS) return "waiting";
  startupWaitDone = true;
  stopBootstrapConnectionStateWatch();
  renderStartupFailure({
    ...state,
    mode: "failed",
    startupError: {
      message: "Workspace startup is taking longer than expected.",
      detail: "Retry startup, inspect the server log, or choose another workspace.",
      ...(state.startupError?.logPath ? { logPath: state.startupError.logPath } : {}),
      ...(state.serverLogPath ? { logPath: state.serverLogPath } : {}),
    },
  });
  return "terminal";
}

/** Host-pushed state transitions land immediately (no poll latency). */
function subscribeToBootstrapStatePush(): void {
  bootstrapApi?.onStateChanged?.((state) => {
    if (startupWaitDone) return;
    if (!isBootstrapConnectionState(state)) return;
    void applyBootstrapState(state);
  });
}

async function getBootstrapStateWithTimeout(): Promise<unknown> {
  if (!bootstrapApi) return null;
  return await Promise.race([
    bootstrapApi.getState().catch(() => null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 5_000)),
  ]);
}

async function startLaunchGate(): Promise<void> {
  bootstrapMain?.setAttribute("data-bootstrap-mode", "approval");
  // Paint the step list before the first activation round trip.
  render();
  launchRefreshLoop.start();
}

async function init(): Promise<void> {
  subscribeToBootstrapStatePush();
  const state = await getBootstrapStateWithTimeout();
  if (isBootstrapConnectionState(state) && state.mode === "choose-connection") {
    renderConnectionChooser(state);
    return;
  }
  if (isBootstrapConnectionState(state) && state.mode === "starting") {
    connectionState = state;
    startupWaitBeganAt = Date.now();
    renderStartingWorkspace();
    waitForConnectedBootstrapState();
    return;
  }
  if (isBootstrapConnectionState(state) && state.mode === "failed") {
    renderStartupFailure(state);
    return;
  }
  await startLaunchGate();
}

void init().catch((err) => {
  renderLaunchError("Vibestudio could not start", err instanceof Error ? err.message : String(err));
});

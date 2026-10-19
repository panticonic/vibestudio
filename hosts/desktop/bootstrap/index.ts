import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import {
  approvalIds,
  launchGateView,
  samePendingApprovals,
  type BootstrapDecision,
  type LaunchGateView,
} from "@vibestudio/shared/bootstrapLaunchGate";
import { parseConnectLink } from "@vibestudio/shared/connect";
import { appendLaunchGateFacts, appendSources } from "./launchGateDom.js";
import {
  isStartupConnectionProgress,
  type StartupConnectionProgress,
} from "../../../src/startupConnectionProgress.js";
import { startupTimeline, type BootstrapTimelinePhase } from "./startupTimeline.js";
import type { LaunchGateView as HostLaunchView, LaunchGateStatus } from "./launchGateModel.js";

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  getLaunchState: () => Promise<unknown>;
  resolveApprovals: (decision: "once" | "deny") => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
  retryStartup: () => Promise<unknown>;
  chooseConnection: () => Promise<unknown>;
  openLog: (path: string) => Promise<unknown>;
  onStateChanged?: (handler: (state: unknown) => void) => () => void;
  onLaunchState?: (handler: (state: unknown) => void) => () => void;
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
  pairingLinkError?: string | null;
  startupError?: {
    message: string;
    detail?: string;
    diagnostics?: string;
    logPath?: string;
  } | null;
  serverLogPath?: string | null;
  startupProgress?: StartupConnectionProgress | null;
};

const globals = globalThis as unknown as {
  __vibestudioBootstrap?: BootstrapBridge;
};
const container = document.getElementById("approvals");
if (!container) throw new Error("Bootstrap approval container missing");
const bootstrapApi = globals.__vibestudioBootstrap;
const approvalsContainer = container;
const launchCopy = document.getElementById("launch-copy");
const bootstrapMain = document.querySelector("main");
const bootstrapHeader = document.querySelector(".launch-header");
const bootstrapEyebrow = document.getElementById("bootstrap-eyebrow");
const bootstrapTitle = document.getElementById("bootstrap-title");

let pending: PendingUnitInstallReviewApproval[] = [];
let rendering = false;
/** What the host last said about the launch; null before the first push. */
let hostLaunch: HostLaunchView | null = null;
/** Header copy for the current launch state; the initial value covers the frame
 * rendered before the host answers with a session. */
let emptyLaunchText = "Connecting to your workspace...";
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;
/** The person declined the review: a decision to report calmly, not a failure. */
let startupDeclined = false;
let startupWaitBeganAt = 0;

function setPending(next: PendingUnitInstallReviewApproval[]): boolean {
  if (samePendingApprovals(pending, next)) return false;
  pending = next;
  const pendingIds = approvalIds(next);
  for (const id of openReviewApprovalIds) {
    if (!pendingIds.has(id)) openReviewApprovalIds.delete(id);
  }
  return true;
}

/** Apply what the host pushed about the launch. */
function setHostLaunch(next: HostLaunchView): void {
  hostLaunch = next;
  startupDeclined = next.launch.status === "unavailable" && next.launch.declined === true;
  setPending(next.launch.status === "approval-required" ? next.launch.approvals : []);
  emptyLaunchText = launchStatusText(next.launch);
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
    // The host relays the decision and continues the launch; its next state arrives as a push.
    if (!bootstrapApi) throw new Error("Launch gate controls are unavailable");
    await bootstrapApi.resolveApprovals(decision);
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

function launchStatusHeader(launch: LaunchGateStatus): {
  eyebrow: string;
  title: string;
  copy: string;
  tone?: "error";
} {
  if (launch.status === "approval-required") {
    return {
      eyebrow: "Before startup",
      title: "Review code before starting",
      copy:
        decisionError ??
        "Vibestudio is waiting for your choice before it runs this workspace's code.",
    };
  }
  if (launch.status === "unavailable" && startupDeclined) {
    return {
      eyebrow: "Not started",
      title: "You chose not to start this workspace",
      copy: "Nothing from this workspace was run. Restart Vibestudio to review it again.",
    };
  }
  if (launch.status === "unavailable") {
    return {
      eyebrow: "Cannot start",
      title: "Vibestudio could not start this workspace",
      copy: launch.reason,
      tone: "error",
    };
  }
  if (launch.status === "failed") {
    return {
      eyebrow: "Cannot start",
      title: "The launch could not complete",
      copy: launch.reason,
      tone: "error",
    };
  }
  if (launch.status === "ready") {
    return {
      eyebrow: "Launching",
      title: "Opening your workspace",
      copy: "The workspace is approved and launching.",
    };
  }
  // starting / preparing: the phase rows carry the technical detail, so the
  // header stays a single readable sentence.
  return { eyebrow: "Starting", title: "Starting workspace", copy: launch.reason };
}

function launchStatusText(launch: LaunchGateStatus): string {
  if (launch.status === "ready") return "The workspace is approved and launching.";
  if (launch.status === "approval-required") {
    return (
      decisionError ?? "Vibestudio is waiting for your choice before it runs this workspace's code."
    );
  }
  if (launch.status === "starting") return launch.reason || "Starting workspace.";
  return launch.reason;
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    approvalsContainer.className = "launch-body";
    if (!hostLaunch) {
      setHeader("Starting", "Starting workspace", emptyLaunchText);
      appendLaunchTimeline(
        approvalsContainer,
        startupTimeline(connectionState?.startupProgress, "complete", [])
      );
      return;
    }
    const header = launchStatusHeader(hostLaunch.launch);
    setHeader(header.eyebrow, header.title, header.copy, header.tone ?? "normal");
    appendLaunchTimeline(
      approvalsContainer,
      startupTimeline(connectionState?.startupProgress, "complete", hostLaunch.progress)
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
    card.setAttribute("aria-label", "Workspace code review");
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
  appendLaunchTimeline(
    approvalsContainer,
    startupTimeline(connectionState?.startupProgress, "failed", hostLaunch?.progress)
  );
}

function isHostLaunchView(value: unknown): value is HostLaunchView {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { launch?: { status?: unknown } }).launch?.status === "string" &&
    Array.isArray((value as { progress?: unknown }).progress)
  );
}

/** The host pushed a launch state: show it. */
function applyHostLaunch(value: unknown): void {
  if (!isHostLaunchView(value)) return;
  setHostLaunch(value);
  if (connectionState?.mode === "connected" || !connectionState) render();
}

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
    (value["pairingLinkError"] === undefined ||
      value["pairingLinkError"] === null ||
      typeof value["pairingLinkError"] === "string") &&
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

function setPairingLinkFailureHeader(reason: string): void {
  bootstrapMain?.setAttribute("data-bootstrap-mode", "connection");
  setHeader("Pairing link", "This pairing link can’t be used", reason, "error");
}

function appendPairingLinkFailure(parent: HTMLElement): void {
  const status = document.createElement("div");
  status.className = "connection-error";
  status.setAttribute("role", "alert");

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Request a fresh pairing link";

  const detail = document.createElement("div");
  detail.className = "meta";
  detail.textContent =
    "Pairing links expire and can be used only once. Generate a new link on the server or ask a paired administrator, then paste it below.";

  status.append(title, detail);
  parent.append(status);
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
      detail: "Opening the workspace. You may be asked to approve its apps first.",
    };
  }
  if (actionId === "pair") {
    return {
      title: "Pairing server",
      detail: "Using the pairing link to connect securely to your server...",
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
    connectionHandoff?.detail ??
      "Opening the workspace. You may be asked to approve its apps first."
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
  if (connectionHandoff) {
    renderConnectionHandoff();
  } else if (connectionState) {
    renderConnectionChooser(connectionState);
  }
  // Connection actions may remain pending until the workspace is approved and
  // ready. The host pushes every state change meanwhile, so the approval is
  // shown while the action is still in flight.
  try {
    await action();
  } catch (err) {
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
    "Paste the pairing link your server printed (or that another device shared). Vibestudio connects securely and opens the server's workspace in this window.";
  const fields = document.createElement("div");
  fields.className = "field-grid";

  const linkLabel = document.createElement("label");
  linkLabel.textContent = "Pairing link";
  const linkInput = document.createElement("input");
  linkInput.name = "link";
  linkInput.type = "text";
  linkInput.placeholder = "https://vibestudio.app/p#...";
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
      if (!link) throw new Error("Paste the pairing link from your server first");
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

  // Existing workspaces launch from their rows; new ones are created from the
  // workspace switcher once a workspace is open. Only a first run names one here.
  if (state.localWorkspaces.length === 0) {
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
    const launchButton = connectionButton("Create and launch", "local:new", async () => {
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
  }

  parent.append(card);
}

function renderConnectionChooser(state: BootstrapConnectionState): void {
  connectionHandoff = null;
  connectionState = state;
  const pairingLinkError = state.pairingLinkError?.trim() || null;
  if (pairingLinkError) setPairingLinkFailureHeader(pairingLinkError);
  else setConnectionHeader();
  approvalsContainer.className = "connection-grid";
  approvalsContainer.replaceChildren();
  if (pairingLinkError) appendPairingLinkFailure(approvalsContainer);
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
  // label + Endpoint ID + Trust/Cancel) rather than silently pairing. Opening a
  // link is not consent to trust the server it points at.
  const awaitingConfirm = !!state.pendingPairLink && !autoPairTriggered && !pairConfirmDismissed;
  if (awaitingConfirm && state.pendingPairLink) {
    appendPairConfirmation(approvalsContainer, state.pendingPairLink);
  } else {
    appendPairRemote(approvalsContainer);
  }
  appendLocalWorkspaces(approvalsContainer, state);
}

/** Group the authenticated Endpoint ID for human comparison. */
function formatEndpointId(endpointId: string): string {
  const hex = endpointId.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return (hex.match(/.{1,2}/g) ?? [hex]).join(":");
}

/**
 * Pairing confirmation: a reassuring card, not a blocker. Shows the server label
 * and authenticated Endpoint ID to compare, with a one-tap Trust / Cancel. Trust
 * pairs; Cancel drops back to the normal chooser.
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
    "You opened a pairing link. Check that this Endpoint ID matches the one your server printed when it started, then connect.";

  const details = document.createElement("div");
  details.className = "field-grid";
  details.style.gap = "6px";

  const fpRow = document.createElement("div");
  const fpLabel = document.createElement("div");
  fpLabel.className = "meta";
  fpLabel.textContent = "Endpoint ID";
  const fpValue = document.createElement("code");
  fpValue.textContent = formatEndpointId(parsed.endpointId);
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
  if (failure?.diagnostics) {
    const details = document.createElement("details");
    details.className = "startup-diagnostics";
    const summary = document.createElement("summary");
    summary.textContent = "Error details";
    const content = document.createElement("pre");
    content.textContent = failure.diagnostics;
    details.append(summary, content);
    approvalsContainer.append(details);
  }
}

/** Show what the host's connection state says. The host pushes every change; nothing polls. */
function applyBootstrapState(state: BootstrapConnectionState): void {
  connectionState = state;
  switch (state.mode) {
    case "failed":
      renderStartupFailure(state);
      return;
    case "connected":
      bootstrapMain?.setAttribute("data-bootstrap-mode", "approval");
      render();
      return;
    case "choose-connection":
      // A pairing or workspace choice is in flight: the host has not yet
      // moved to "starting", and the chooser must not flash back over it.
      if (connectionBusyAction) renderConnectionHandoff();
      else renderConnectionChooser(state);
      return;
    case "starting":
      renderStartingWorkspace();
      return;
  }
}

function subscribeToHostPushes(): void {
  bootstrapApi?.onStateChanged?.((state) => {
    if (isBootstrapConnectionState(state)) applyBootstrapState(state);
  });
  bootstrapApi?.onLaunchState?.(applyHostLaunch);
}

async function init(): Promise<void> {
  subscribeToHostPushes();
  if (!bootstrapApi) throw new Error("Launch gate controls are unavailable");
  const [state, launch] = await Promise.all([
    bootstrapApi.getState(),
    bootstrapApi.getLaunchState(),
  ]);
  if (isHostLaunchView(launch)) setHostLaunch(launch);
  if (!isBootstrapConnectionState(state)) {
    throw new Error("The host did not report a connection state");
  }
  if (state.mode === "starting") startupWaitBeganAt = Date.now();
  applyBootstrapState(state);
}

void init().catch((err) => {
  renderLaunchError("Vibestudio could not start", err instanceof Error ? err.message : String(err));
});

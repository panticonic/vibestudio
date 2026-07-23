import {
  createRpcClient,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import {
  approvalIds,
  formatCapabilities,
  launchCopy as getLaunchCopy,
  plural,
  samePendingApprovals,
  type BootstrapDecision,
  unitKindLabel,
  unitReviewRows,
  unitSourceLabel,
  unitSummaryChips,
} from "@vibestudio/shared/bootstrapLaunchGate";
import {
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
  isLaunchSessionEventFor,
  isLaunchSessionEventForTarget,
} from "@vibestudio/shared/hostTargetLaunchGate";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type {
  HostTargetLaunchSessionSnapshot,
  HostTargetLaunchTimelinePhase,
} from "@vibestudio/shared/hostTargets";
import { parseConnectLink } from "@vibestudio/shared/connect";

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
  startupDetail?: string | null;
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

function createWorkspaceClient() {
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
  return createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
    nextRpc.call("main", `${service}.${method}`, args)
  );
}

type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
let workspaceClient: WorkspaceClient | null = null;

function getWorkspaceClient(): WorkspaceClient {
  workspaceClient ??= createWorkspaceClient();
  return workspaceClient;
}

function getRpc(): RpcClient {
  getWorkspaceClient();
  if (!rpc) throw new Error("Bootstrap RPC unavailable");
  return rpc;
}

let eventsClient: EventsClient | null = null;
function getEventsClient(): EventsClient {
  eventsClient ??= new EventsClient(getRpc());
  return eventsClient;
}
const hostTarget = "electron";
const launchEventNames = [HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT] as const;
let pending: PendingUnitBatchApproval[] = [];
let rendering = false;
let refreshInFlight = false;
let refreshScheduled = false;
let launchSession: HostTargetLaunchSessionSnapshot | null = null;
/** Header copy for the current launch state; the initial value covers the frame
 * rendered before the host answers with a session. */
let emptyLaunchText = "Connecting to your workspace...";
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;
let startupWaitBeganAt = 0;
const STARTUP_POLL_TIMEOUT_MS = 135_000;

function scheduleRefresh(): void {
  if (refreshScheduled || refreshInFlight) return;
  refreshScheduled = true;
  window.setTimeout(() => {
    refreshScheduled = false;
    void refresh();
  }, 0);
}

function setPending(next: PendingUnitBatchApproval[]): boolean {
  if (samePendingApprovals(pending, next)) return false;
  pending = next;
  const pendingIds = approvalIds(next);
  for (const id of openReviewApprovalIds) {
    if (!pendingIds.has(id)) openReviewApprovalIds.delete(id);
  }
  return true;
}

function setLaunchSession(next: HostTargetLaunchSessionSnapshot): boolean {
  const previousSession = launchSession;
  launchSession = next;
  const pendingChanged = setPending(next.approvals);
  const text = launchSessionText(next);
  const textChanged = text !== emptyLaunchText;
  emptyLaunchText = text;
  return (
    pendingChanged ||
    textChanged ||
    previousSession?.sessionId !== next.sessionId ||
    previousSession?.status !== next.status ||
    previousSession?.currentPhase !== next.currentPhase ||
    previousSession?.detail !== next.detail
  );
}

async function decide(
  approval: PendingUnitBatchApproval,
  decision: BootstrapDecision
): Promise<void> {
  const sessionId = launchSession?.sessionId;
  if (!sessionId) return;
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
    const session = await getWorkspaceClient().hostTargets.resolveLaunchSessionApproval(
      sessionId,
      decision
    );
    setLaunchSession(session);
    await refresh();
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
  approval: PendingUnitBatchApproval,
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

function appendUnitSummary(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const summary = document.createElement("div");
  summary.className = "unit-summary";
  const total = document.createElement("div");
  total.className = "unit-summary-total";
  total.textContent = plural(approval.units.length, "privileged unit");
  summary.append(total);

  const chips = document.createElement("div");
  chips.className = "unit-summary-chips";
  for (const label of unitSummaryChips(approval)) {
    const chip = document.createElement("span");
    chip.className = "unit-chip";
    chip.textContent = label;
    chips.append(chip);
  }
  summary.append(chips);
  card.append(summary);
}

function appendUnitReview(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const details = document.createElement("details");
  details.className = "unit-review";
  details.open = openReviewApprovalIds.has(approval.approvalId);
  details.addEventListener("toggle", () => {
    if (details.open) openReviewApprovalIds.add(approval.approvalId);
    else openReviewApprovalIds.delete(approval.approvalId);
  });
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = "Review details";
  const hint = document.createElement("span");
  hint.className = "unit-review-hint";
  hint.textContent = "sources, versions, capabilities";
  summary.append(title, hint);
  details.append(summary);

  const list = document.createElement("ul");
  list.className = "unit-list";
  const rows = unitReviewRows(approval);
  approval.units.forEach((unit, index) => {
    const review = rows[index];
    if (review === undefined) return;
    const row = document.createElement("li");
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "unit-name";
    name.textContent = review.name;
    const meta = document.createElement("div");
    meta.className = "unit-meta";
    meta.textContent = unitSourceLabel(unit);
    const caps = document.createElement("div");
    caps.className = "unit-capabilities";
    caps.textContent = formatCapabilities(unit);
    const kind = document.createElement("div");
    kind.className = "unit-kind";
    kind.textContent = unitKindLabel(unit);
    text.append(name, meta, caps);
    row.append(text, kind);
    list.append(row);
  });
  details.append(list);
  card.append(details);
}

function appendApprovalActions(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const actions = document.createElement("div");
  actions.className = "toolbar";
  appendDecisionButton(actions, approval, "Trust and start", "once", "primary");
  appendDecisionButton(actions, approval, "Deny", "deny", "danger");
  card.append(actions);
  if (decidingApprovalIds.has(approval.approvalId)) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "Starting the workspace...";
    card.append(status);
  }
}

function appendLaunchTimeline(
  parent: HTMLElement,
  phases: readonly HostTargetLaunchTimelinePhase[]
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
 * The pre-session half of the SAME timeline the host emits once a launch session
 * exists (launchTimeline() in hostTargetLaunchCoordinator): same phase ids, same
 * labels, same order. Startup used to show a single sentence here and only grew
 * the step list once the host answered, so the window changed shape mid-launch.
 * Rendering these phases from the first frame means the host snapshot is a
 * continuation - the "Connect" row just flips from active to complete.
 *
 * The bootstrap window always launches the electron target, so the target-named
 * labels are fixed to "desktop" (targetLabel("electron")).
 */
function startupTimeline(
  detail: string | null | undefined,
  connectState: HostTargetLaunchTimelinePhase["state"] = "active"
): HostTargetLaunchTimelinePhase[] {
  return [
    {
      id: "pair",
      label: "Connect",
      state: connectState,
      ...(detail ? { detail } : {}),
    },
    { id: "review-trust", label: "Review trust", state: "pending" },
    { id: "start-units", label: "Start privileged units", state: "pending" },
    { id: "build-app", label: "Build desktop app", state: "pending" },
    { id: "activate-target", label: "Activate desktop", state: "pending" },
    { id: "connected", label: "Connected", state: "pending" },
  ];
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

function launchSessionHeader(session: HostTargetLaunchSessionSnapshot): {
  eyebrow: string;
  title: string;
  copy: string;
  tone?: "error";
} {
  if (session.status === "approval-required") {
    return {
      eyebrow: "Workspace approval",
      title: "Do you trust the code in this workspace?",
      copy:
        decisionError ?? "Review the workspace code that wants to run before Vibestudio starts.",
    };
  }
  if (session.status === "denied") {
    return {
      eyebrow: "Startup denied",
      title: "Nothing was started",
      copy: session.message,
      tone: "error",
    };
  }
  if (session.status === "unavailable") {
    return {
      eyebrow: "Cannot start",
      title: "Vibestudio could not start this workspace",
      copy: [session.message, session.detail].filter(Boolean).join(" "),
      tone: "error",
    };
  }
  if (session.status === "ready") {
    return { eyebrow: "Launching", title: "Opening your workspace", copy: session.message };
  }
  // starting / preparing: the phase rows carry the technical detail, so the
  // header stays a single readable sentence.
  return { eyebrow: "Starting", title: "Starting workspace", copy: session.message };
}

function launchSessionText(session: HostTargetLaunchSessionSnapshot): string {
  if (session.status === "ready") return "The workspace is approved and launching.";
  if (session.status === "denied") return session.message;
  if (session.status === "unavailable") {
    return [session.message, session.detail].filter(Boolean).join(" ");
  }
  if (session.status === "approval-required") {
    return decisionError ?? "Review the workspace code that wants to run before Vibestudio starts.";
  }
  return [session.message, session.detail].filter(Boolean).join(" ");
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    approvalsContainer.className = "launch-body";
    if (!launchSession) {
      setHeader("Starting", "Starting workspace", emptyLaunchText);
      appendLaunchTimeline(approvalsContainer, startupTimeline(null));
      return;
    }
    const header = launchSessionHeader(launchSession);
    setHeader(header.eyebrow, header.title, header.copy, header.tone ?? "normal");
    appendLaunchTimeline(approvalsContainer, launchSession.timeline);
    if (pending.length === 0) {
      if (launchSession.status === "denied") appendDeniedRecovery(approvalsContainer);
      return;
    }
    for (const approval of pending) {
      const copy = getLaunchCopy(approval);
      const card = document.createElement("article");
      card.className = "approval";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = copy.title;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = copy.summary;

      card.append(title, meta);
      appendUnitSummary(card, approval);
      appendUnitReview(card, approval);
      appendApprovalActions(card, approval);
      approvalsContainer.appendChild(card);
    }
  } finally {
    rendering = false;
  }
}

function appendDeniedRecovery(parent: HTMLElement): void {
  const explanation = document.createElement("div");
  explanation.className = "status";
  explanation.textContent =
    "No workspace app or extension code was started. You can review the request again without restarting Vibestudio.";
  const actions = document.createElement("div");
  actions.className = "toolbar";
  const review = document.createElement("button");
  review.className = "primary";
  review.textContent = "Review again";
  review.onclick = () => {
    launchSession = null;
    void refresh();
  };
  const choose = document.createElement("button");
  choose.textContent = "Choose another workspace";
  choose.onclick = () => void bootstrapApi?.chooseConnection();
  actions.append(review, choose);
  parent.append(explanation, actions);
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

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const session =
      (launchSession
        ? await getWorkspaceClient().hostTargets.getLaunchSession(launchSession.sessionId)
        : null) ?? (await getWorkspaceClient().hostTargets.beginLaunch(hostTarget));
    if (setLaunchSession(session)) render();
  } catch (err) {
    renderLaunchError(
      "Launch gate could not reach the host",
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    refreshInFlight = false;
  }
}

async function subscribeToLaunchEvents(): Promise<void> {
  const eventClient = getEventsClient();
  for (const eventName of launchEventNames) {
    eventClient.on(eventName, (payload) => {
      if (launchSession && isLaunchSessionEventFor(launchSession.sessionId, eventName, payload)) {
        if (setLaunchSession(payload)) render();
        return;
      }
      if (isLaunchSessionEventForTarget(hostTarget, eventName, payload)) scheduleRefresh();
    });
    await eventClient.subscribe(eventName);
  }
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
      value["connectionKind"] === null)
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
  // The same step list the launch gate shows, so this state is the first leg of
  // one journey rather than a different-looking screen. The live host progress
  // rides on the active phase instead of being a second status line.
  appendLaunchTimeline(approvalsContainer, startupTimeline(connectionState?.startupDetail));
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
  try {
    await action();
    // No relaunch: the host resolves the choice and connects in THIS process and
    // window. Show the starting state and watch the bootstrap state (host push
    // + fallback poll) until the launch gate is ready.
    startupWaitDone = false;
    renderStartingWorkspace();
    waitForConnectedBootstrapState();
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
  title.textContent = "Trust this server?";

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
  appendLaunchTimeline(approvalsContainer, startupTimeline(state.startupDetail, "failed"));
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
    renderStartupFailure(state);
    return "terminal";
  }
  if (state.mode === "connected") {
    startupWaitDone = true;
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
    renderConnectionChooser(state);
    return "terminal";
  }
  renderStartingWorkspace();
  return "waiting";
}

function waitForConnectedBootstrapState(): void {
  window.setTimeout(async () => {
    if (startupWaitDone) return;
    const state = await getBootstrapStateWithTimeout();
    if (startupWaitDone) return;
    if (!isBootstrapConnectionState(state)) {
      if (Date.now() - startupWaitBeganAt >= STARTUP_POLL_TIMEOUT_MS) {
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
        return;
      }
      waitForConnectedBootstrapState();
      return;
    }
    if ((await applyBootstrapState(state)) === "terminal") return;
    if (Date.now() - startupWaitBeganAt >= STARTUP_POLL_TIMEOUT_MS) {
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
      return;
    }
    waitForConnectedBootstrapState();
    // Pushed state drives the UI; this poll is only a liveness fallback, so it
    // can be slow.
  }, 2_000);
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
  // Paint the step list right away: subscribing and fetching the session takes a
  // round trip, and a launch window that shows nothing (or a trust question
  // nobody has asked yet) for that beat is worse than showing where we are.
  render();
  await subscribeToLaunchEvents().catch((err) => {
    renderLaunchError(
      "Launch gate could not subscribe to host events",
      err instanceof Error ? err.message : String(err)
    );
  });
  await refresh();
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

import {
  createRpcClient,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@natstack/rpc";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
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
} from "@natstack/shared/bootstrapLaunchGate";
import {
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
  isLaunchSessionEventFor,
  isLaunchSessionEventForTarget,
} from "@natstack/shared/hostTargetLaunchGate";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import type { HostTargetLaunchSessionSnapshot } from "@natstack/shared/hostTargets";

type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

const globals = globalThis as unknown as { __natstackTransport?: ShellTransportBridge };
const container = document.getElementById("approvals");
if (!container) throw new Error("Bootstrap approval container missing");
const bootstrapTransport = globals.__natstackTransport;
if (!bootstrapTransport) throw new Error("Bootstrap transport unavailable");
const approvalsContainer = container;
const launchCopy = document.getElementById("launch-copy");

const transport: EnvelopeRpcTransport = {
  send: (envelope) => bootstrapTransport.send(envelope.target, envelope.message),
  onMessage: (handler) =>
    bootstrapTransport.onMessage((fromId, message) => {
      handler(
        envelopeFromMessage({
          selfId: "bootstrap",
          from: fromId,
          target: "bootstrap",
          callerKind: fromId === "main" ? "server" : "unknown",
          message: message as RpcEnvelope["message"],
        })
      );
    }),
  status: () => "connected",
  ready: () => Promise.resolve(),
  onStatusChange: () => () => {},
};

const rpc: RpcClient = createRpcClient({ selfId: "bootstrap", callerKind: "app", transport });
const workspaceClient = createTypedServiceClient(
  "workspace",
  workspaceMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const hostTarget = "electron";
const launchEventNames = [HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT] as const;
let pending: PendingUnitBatchApproval[] = [];
let rendering = false;
let refreshInFlight = false;
let refreshScheduled = false;
let launchSession: HostTargetLaunchSessionSnapshot | null = null;
let emptyLaunchText = "No workspace approval is pending. Starting the workspace...";
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;

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
  if (launchCopy) {
    launchCopy.textContent =
      decision === "deny"
        ? "Denying startup approval..."
        : "Approval recorded. Starting the workspace...";
  }
  render();
  try {
    const session = await workspaceClient.hostTargets.resolveLaunchSessionApproval(
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
    const review = rows[index]!;
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

function appendLaunchTimeline(parent: HTMLElement, session: HostTargetLaunchSessionSnapshot): void {
  const list = document.createElement("ol");
  list.className = "launch-timeline";
  for (const phase of session.timeline) {
    const item = document.createElement("li");
    item.className = `launch-phase ${phase.state}`;
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

function launchSessionText(session: HostTargetLaunchSessionSnapshot): string {
  if (session.status === "ready") return "The workspace is approved and launching.";
  if (session.status === "denied") return session.message;
  if (session.status === "unavailable") {
    return [session.message, session.detail].filter(Boolean).join(" ");
  }
  if (session.status === "approval-required") {
    return decisionError ?? "Review the workspace code that wants to run before NatStack starts.";
  }
  return [session.message, session.detail].filter(Boolean).join(" ");
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    if (pending.length === 0) {
      approvalsContainer.className = "launch-card empty";
      const message = document.createElement("div");
      message.className = "empty-message";
      message.textContent = emptyLaunchText;
      approvalsContainer.append(message);
      if (launchSession) appendLaunchTimeline(approvalsContainer, launchSession);
      if (launchCopy) {
        launchCopy.textContent = emptyLaunchText;
      }
      return;
    }
    approvalsContainer.className = "launch-card";
    if (launchCopy) {
      launchCopy.textContent =
        decisionError ?? "Review the workspace code that wants to run before NatStack starts.";
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

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const session =
      (launchSession
        ? await workspaceClient.hostTargets.getLaunchSession(launchSession.sessionId)
        : null) ?? (await workspaceClient.hostTargets.beginLaunch(hostTarget));
    if (setLaunchSession(session)) render();
  } catch (err) {
    approvalsContainer.className = "launch-card empty";
    approvalsContainer.textContent = `Launch gate could not reach the host: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refreshInFlight = false;
  }
}

async function subscribeToLaunchEvents(): Promise<void> {
  for (const eventName of launchEventNames) {
    rpc.on(`event:${eventName}`, (payload) => {
      if (launchSession && isLaunchSessionEventFor(launchSession.sessionId, eventName, payload)) {
        if (setLaunchSession(payload)) render();
        return;
      }
      if (isLaunchSessionEventForTarget(hostTarget, eventName, payload)) scheduleRefresh();
    });
    await rpc.call("main", "events.subscribe", [eventName]);
  }
}

void subscribeToLaunchEvents()
  .catch((err) => {
    approvalsContainer.className = "launch-card empty";
    approvalsContainer.textContent = `Launch gate could not subscribe to host events: ${
      err instanceof Error ? err.message : String(err)
    }`;
  })
  .finally(() => void refresh());

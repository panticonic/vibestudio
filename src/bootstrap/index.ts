import {
  createRpcClient,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@natstack/rpc";
import type {
  PendingApproval,
  PendingUnitBatchApproval,
  UnitBatchEntry,
} from "@natstack/shared/approvals";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
import { filterBootstrapApprovalsForTarget } from "@natstack/shared/bootstrapApprovals";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";

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
let pending: PendingUnitBatchApproval[] = [];
let rendering = false;
let refreshTimer: number | null = null;
let refreshInFlight = false;
let launchAttempted = false;
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;
type BootstrapDecision = "once" | "deny";

function stopRefreshLoop(): void {
  if (refreshTimer === null) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function approvalSignature(approval: PendingUnitBatchApproval): string {
  return [
    approval.approvalId,
    approval.trigger,
    ...approval.units.map((unit) =>
      [
        unit.unitKind,
        unit.unitName,
        unit.target ?? "",
        unit.source.repo,
        unit.source.ref,
        unit.ev ?? "",
      ].join(":")
    ),
  ].join("|");
}

function pendingSignature(approvals: PendingUnitBatchApproval[]): string {
  return approvals.map(approvalSignature).join("\n");
}

function setPending(next: PendingUnitBatchApproval[]): boolean {
  if (pendingSignature(pending) === pendingSignature(next)) return false;
  pending = next;
  const pendingIds = new Set(next.map((approval) => approval.approvalId));
  for (const id of openReviewApprovalIds) {
    if (!pendingIds.has(id)) openReviewApprovalIds.delete(id);
  }
  return true;
}

async function decide(
  approval: PendingUnitBatchApproval,
  decision: BootstrapDecision
): Promise<void> {
  if (decidingApprovalIds.has(approval.approvalId)) return;
  decidingApprovalIds.add(approval.approvalId);
  decisionError = null;
  if (launchCopy) {
    launchCopy.textContent =
      decision === "deny"
        ? "Denying startup approval..."
        : "Approval recorded. Starting the workspace...";
  }
  render();
  try {
    await rpc.call("main", RPC_METHODS.shellApproval.resolveBootstrap, [
      approval.approvalId,
      decision,
    ]);
    setPending(pending.filter((item) => item.approvalId !== approval.approvalId));
    await refresh();
  } catch (err) {
    decisionError = `Approval failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    decidingApprovalIds.delete(approval.approvalId);
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

function launchTitle(approval: PendingUnitBatchApproval): string {
  return approval.trigger === "meta-change"
    ? "Workspace code changed"
    : "Apps and extensions requesting trust";
}

function launchSummary(approval: PendingUnitBatchApproval): string {
  if (approval.trigger === "meta-change") {
    return "The workspace configuration changed. Review the privileged workspace code before continuing.";
  }
  return "Approving lets NatStack run the listed apps and extensions locally.";
}

function unitKindLabel(unit: UnitBatchEntry): string {
  if (unit.target === "electron") return "Desktop";
  if (unit.target === "react-native") return "Mobile";
  if (unit.target === "terminal") return "Terminal";
  return unit.unitKind === "extension" ? "Extension" : "App";
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function unitCounts(approval: PendingUnitBatchApproval): {
  apps: number;
  extensions: number;
  desktop: number;
  mobile: number;
  terminal: number;
} {
  return approval.units.reduce(
    (counts, unit) => {
      if (unit.unitKind === "app") counts.apps += 1;
      if (unit.unitKind === "extension") counts.extensions += 1;
      if (unit.target === "electron") counts.desktop += 1;
      if (unit.target === "react-native") counts.mobile += 1;
      if (unit.target === "terminal") counts.terminal += 1;
      return counts;
    },
    { apps: 0, extensions: 0, desktop: 0, mobile: 0, terminal: 0 }
  );
}

function appendUnitSummary(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const counts = unitCounts(approval);
  const summary = document.createElement("div");
  summary.className = "unit-summary";
  const total = document.createElement("div");
  total.className = "unit-summary-total";
  total.textContent = plural(approval.units.length, "privileged unit");
  summary.append(total);

  const chips = document.createElement("div");
  chips.className = "unit-summary-chips";
  const chipInputs = [
    counts.apps > 0 ? plural(counts.apps, "app") : null,
    counts.extensions > 0 ? plural(counts.extensions, "extension") : null,
    counts.desktop > 0 ? plural(counts.desktop, "desktop app") : null,
    counts.mobile > 0 ? plural(counts.mobile, "mobile app") : null,
    counts.terminal > 0 ? plural(counts.terminal, "terminal app") : null,
  ].filter((item): item is string => item !== null);
  for (const label of chipInputs) {
    const chip = document.createElement("span");
    chip.className = "unit-chip";
    chip.textContent = label;
    chips.append(chip);
  }
  summary.append(chips);
  card.append(summary);
}

function formatCapabilities(unit: UnitBatchEntry): string {
  if (!unit.capabilities.length) return "No declared capabilities";
  return unit.capabilities.join(", ");
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
  for (const unit of approval.units) {
    const row = document.createElement("li");
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "unit-name";
    name.textContent = unit.displayName || unit.unitName;
    const meta = document.createElement("div");
    meta.className = "unit-meta";
    meta.textContent = `${unit.source.repo}@${unit.source.ref}${unit.ev ? ` - ${unit.ev.slice(0, 12)}` : ""}`;
    const caps = document.createElement("div");
    caps.className = "unit-capabilities";
    caps.textContent = formatCapabilities(unit);
    const kind = document.createElement("div");
    kind.className = "unit-kind";
    kind.textContent = unitKindLabel(unit);
    text.append(name, meta, caps);
    row.append(text, kind);
    list.append(row);
  }
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

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    if (pending.length === 0) {
      approvalsContainer.className = "launch-card empty";
      approvalsContainer.textContent =
        "No workspace approval is pending. Starting the workspace...";
      if (launchCopy) {
        launchCopy.textContent =
          "The workspace is starting. Additional approvals may appear after launch.";
      }
      return;
    }
    approvalsContainer.className = "launch-card";
    if (launchCopy) {
      launchCopy.textContent =
        decisionError ?? "Review the workspace code that wants to run before NatStack starts.";
    }
    for (const approval of pending) {
      const card = document.createElement("article");
      card.className = "approval";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = launchTitle(approval);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = launchSummary(approval);

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
    if (launchAttempted && pending.length > 0) {
      const approvals = await rpc.call<PendingApproval[]>(
        "main",
        RPC_METHODS.shellApproval.listPending,
        []
      );
      const bootstrapApprovals = filterBootstrapApprovalsForTarget(approvals, hostTarget);
      if (bootstrapApprovals.length > 0) {
        if (setPending(bootstrapApprovals)) render();
        return;
      }
    }

    const launch = await workspaceClient.hostTargets.launch(hostTarget);
    launchAttempted = true;
    if (launch.status === "approval-required") {
      if (setPending(launch.approvals)) render();
      return;
    }
    if (launch.status === "ready") {
      setPending([]);
      if (launchCopy) launchCopy.textContent = "The workspace is approved and launching.";
      stopRefreshLoop();
      render();
      return;
    }
    setPending([]);
    if (launchCopy) launchCopy.textContent = launch.reason;
    render();
  } catch (err) {
    approvalsContainer.className = "launch-card empty";
    approvalsContainer.textContent = `Launch gate could not reach the host: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refreshInFlight = false;
  }
}

void refresh();
refreshTimer = window.setInterval(() => void refresh(), 2000);

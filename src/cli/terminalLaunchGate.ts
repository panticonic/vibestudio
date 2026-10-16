import readline from "node:readline/promises";
import {
  formatLaunchGateForTerminal,
  formatLaunchGateUnitsForTerminal,
  launchGateView,
  targetLabel,
  type BootstrapDecision,
} from "@vibestudio/shared/bootstrapLaunchGate";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import type { HostTarget } from "@vibestudio/shared/hostTargets";
import {
  HostLaunchClient,
  type HostLaunchProgress,
  type HostLaunchResult,
} from "@vibestudio/service-schemas/clients/hostLaunchClient";
import {
  qualifyServiceMethod,
  type QualifiedServiceMethod,
} from "@vibestudio/shared/typedServiceClient";
import { CliError, UsageError } from "./output.js";

/** Conventional exit status for a SIGINT-terminated command. */
export const EXIT_INTERRUPTED = 130;

export interface TerminalLaunchGateOptions {
  target?: HostTarget;
  /** Approve each startup approval once without prompting. */
  yes?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Concise progress lines (build/activation status) for the user. */
  onProgress?(line: string): void;
  /**
   * The owner's termination request. It ends an open approval prompt and the
   * wait for activation, so a hang-up or SIGTERM never leaves the prompt
   * holding the terminal after the server it asks about is gone.
   */
  signal?: AbortSignal;
  /**
   * Workspaces started together with the launch target's (the account's
   * Personal workspace beside System): their creation reviews are asked in
   * this same gate, once.
   */
  companions?: readonly LaunchGateRpc[];
}

/** What the server is doing to bring the app up, in the person's words. */
function describeLaunchProgress(progress: HostLaunchProgress): string | null {
  if (progress.state === "complete") return null;
  const detail = progress.detail ? `: ${progress.detail}` : "";
  switch (progress.phase) {
    case "resolve-target":
      return progress.state === "failed" ? `Could not find the app to start${detail}` : null;
    case "start-units":
      return progress.state === "blocked"
        ? "Waiting for your approval of the extensions it needs"
        : `Starting the extensions it needs${detail}`;
    case "prepare-app":
      return progress.state === "blocked"
        ? "Waiting for your approval of the app"
        : progress.state === "failed"
          ? `The app could not be prepared${detail}`
          : `Building and starting the app${detail}`;
  }
}

export interface TerminalLaunchGateResult {
  target: HostTarget;
  status: HostLaunchResult["status"] | "denied";
  approvalsResolved: number;
  launch?: HostLaunchResult;
}

/** Minimal RPC surface the gate needs: the CLI's own authenticated device client. */
export interface LaunchGateRpc {
  call(method: QualifiedServiceMethod, args?: unknown[]): Promise<unknown>;
}

/**
 * Resolve, approve, and activate the workspace's host-target app before any
 * client takes over the terminal. Approval prompts are line-mode questions on
 * the real terminal; they stay open until the user answers.
 *
 * Activation (build + admission) is owned by the workspace supervisor. While it
 * reports `preparing`, the gate asks again once a second and reports each new
 * status line, so the user sees build progress instead of a silent wait.
 */
export async function runTerminalLaunchGate(
  rpc: LaunchGateRpc,
  options: TerminalLaunchGateOptions = {}
): Promise<TerminalLaunchGateResult> {
  const target = options.target ?? "terminal";
  const output = options.output ?? process.stdout;
  let lastLaunchProgress = "";
  const launchClient = new HostLaunchClient(
    (service, method, args) => rpc.call(qualifyServiceMethod(service, method), args),
    (progress) => {
      const line = describeLaunchProgress(progress);
      if (line && line !== lastLaunchProgress) options.onProgress?.(line);
      lastLaunchProgress = line ?? "";
    },
    (options.companions ?? []).map(
      (companion) => (service: string, method: string, args: unknown[]) =>
        companion.call(qualifyServiceMethod(service, method), args)
    )
  );
  let approvalsResolved = 0;
  let lastProgress = "";

  for (;;) {
    options.signal?.throwIfAborted();
    const launch = await launchClient.launch(target);
    if (launch.status === "ready" || launch.status === "unavailable") {
      return { target, status: launch.status, approvalsResolved, launch };
    }
    if (launch.status === "approval-required") {
      output.write(`\n${formatLaunchGateForTerminal(launch.approvals, target, width(output))}\n\n`);
      const decision = await getDecision(target, launch.approvals, options);
      await launchClient.resolveApprovals(launch.approvals, decision);
      if (decision === "deny") {
        return { target, status: "denied", approvalsResolved };
      }
      approvalsResolved += launch.approvals.length;
      lastProgress = "";
      continue;
    }
    if (launch.reason !== lastProgress) {
      options.onProgress?.(launch.reason);
      lastProgress = launch.reason;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function width(output: NodeJS.WriteStream): number {
  return Math.max(40, Math.min(output.columns ?? 80, 100));
}

async function getDecision(
  target: HostTarget,
  approvals: PendingUnitInstallReviewApproval[],
  options: TerminalLaunchGateOptions
): Promise<BootstrapDecision> {
  if (options.yes) return "once";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError(
      `${targetLabel(target)} startup needs your approval, but this is not an interactive ` +
        "terminal. Re-run in a terminal, or pass --yes to approve once."
    );
  }
  const rl = readline.createInterface({ input, output });
  // Ctrl-C at the prompt ends startup; without a listener readline only pauses.
  // So does the owner's termination request.
  const interrupted = new AbortController();
  rl.on("SIGINT", () => interrupted.abort());
  const ownerSignal = options.signal;
  const stopOnOwner = () => interrupted.abort();
  if (ownerSignal?.aborted) interrupted.abort();
  else ownerSignal?.addEventListener("abort", stopOnOwner, { once: true });
  const view = launchGateView({ approvals });
  // The same two actions as the window, plus its disclosure: the programs
  // themselves, listed on request rather than ahead of the question.
  const question =
    `${view.acceptLabel}: y  ·  ${view.declineLabel}: n  ·  ${view.disclosureLabel}: r\n` +
    "Your choice [y/n/r]: ";
  try {
    for (;;) {
      const answer = (await rl.question(question, { signal: interrupted.signal }))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return "once";
      if (answer === "n" || answer === "no") return "deny";
      if (answer === "r") {
        output.write(`\n${formatLaunchGateUnitsForTerminal(approvals, width(output))}\n\n`);
        continue;
      }
      output.write("Please answer y, n or r.\n");
    }
  } catch (error) {
    if (interrupted.signal.aborted) {
      output.write("\n");
      throw new CliError("Startup interrupted; nothing was approved.", EXIT_INTERRUPTED);
    }
    throw error;
  } finally {
    ownerSignal?.removeEventListener("abort", stopOnOwner);
    rl.close();
  }
}

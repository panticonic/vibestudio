import readline from "node:readline/promises";
import {
  formatLaunchGateForTerminal,
  targetLabel,
  type BootstrapDecision,
} from "@vibestudio/shared/bootstrapLaunchGate";
import type { HostTarget } from "@vibestudio/shared/hostTargets";
import {
  HostLaunchClient,
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
  const launchClient = new HostLaunchClient((service, method, args) =>
    rpc.call(qualifyServiceMethod(service, method), args)
  );
  let approvalsResolved = 0;
  let lastProgress = "";

  for (;;) {
    const launch = await launchClient.launch(target);
    if (launch.status === "ready" || launch.status === "unavailable") {
      return { target, status: launch.status, approvalsResolved, launch };
    }
    if (launch.status === "approval-required") {
      output.write(`\n${formatLaunchGateForTerminal(launch.approvals, target)}\n\n`);
      const decision = await getDecision(target, options);
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

async function getDecision(
  target: HostTarget,
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
  const interrupted = new AbortController();
  rl.on("SIGINT", () => interrupted.abort());
  try {
    for (;;) {
      const answer = (await rl.question("Trust and start? [y/N] ", { signal: interrupted.signal }))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return "once";
      if (answer === "" || answer === "n" || answer === "no") return "deny";
      output.write("Please answer y or n.\n");
    }
  } catch (error) {
    if (interrupted.signal.aborted) {
      output.write("\n");
      throw new CliError("Startup interrupted; nothing was approved.", EXIT_INTERRUPTED);
    }
    throw error;
  } finally {
    rl.close();
  }
}

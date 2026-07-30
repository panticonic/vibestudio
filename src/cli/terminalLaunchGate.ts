import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { TimeoutError } from "./output.js";

export interface TerminalLaunchGateOptions {
  target?: HostTarget;
  yes?: boolean;
  json?: boolean;
  /** Overall wait deadline. Defaults to ten minutes. */
  timeoutMs?: number;
}

export interface TerminalLaunchGateResult {
  target: HostTarget;
  status: HostLaunchResult["status"] | "denied";
  approvalsResolved: number;
  launch?: HostLaunchResult;
}

export async function runTerminalLaunchGate(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken"> &
    Partial<Pick<DeviceCredential, "workspacePairing">>,
  options: TerminalLaunchGateOptions = {}
): Promise<TerminalLaunchGateResult> {
  const target = options.target ?? "terminal";
  const rpc = new RpcClient(creds);
  const launchClient = new HostLaunchClient((service, method, args) =>
    rpc.call(`${service}.${method}`, args)
  );
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  let approvalsResolved = 0;
  let lastProgress = "";

  try {
    for (;;) {
      const launch = await launchClient.launch(target);
      if (launch.status === "ready" || launch.status === "unavailable") {
        return { target, status: launch.status, approvalsResolved, launch };
      }
      if (launch.status === "approval-required") {
        if (!options.json) {
          output.write(`${formatLaunchGateForTerminal(launch.approvals, target)}\n\n`);
        }
        const decision = await getDecision(target, options);
        await launchClient.resolveApprovals(launch.approvals, decision);
        if (decision === "deny") {
          return { target, status: "denied", approvalsResolved };
        }
        approvalsResolved += launch.approvals.length;
        lastProgress = "";
        continue;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new TimeoutError(
          `terminal startup timed out after ${formatElapsed(elapsed)}; last status: ${launch.reason}. ` +
            "Run `vibestudio agent diag <unit>` for build/runtime details."
        );
      }
      if (!options.json && launch.reason !== lastProgress) {
        output.write(`${launch.reason}\n`);
        lastProgress = launch.reason;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, timeoutMs - elapsed)));
    }
  } finally {
    await rpc.close();
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

async function getDecision(
  target: HostTarget,
  options: TerminalLaunchGateOptions
): Promise<BootstrapDecision> {
  if (options.yes) return "once";
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      `${targetLabel(target)} startup approval requires an interactive terminal. ` +
        "Re-run with --yes to approve once non-interactively."
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question("Trust and start? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return "once";
      if (answer === "" || answer === "n" || answer === "no") return "deny";
      output.write("Please answer y or n.\n");
    }
  } finally {
    rl.close();
  }
}

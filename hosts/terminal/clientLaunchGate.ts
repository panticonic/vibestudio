import readline from "node:readline/promises";
import {
  formatLaunchGateForTerminal,
  formatLaunchGateUnitsForTerminal,
  hostLabel,
  launchGateView,
  type BootstrapDecision,
} from "@vibestudio/shared/bootstrapLaunchGate";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import type { ClientLauncher, LaunchedClient, LaunchState } from "@vibestudio/client-host-core";
import type { ClientSelection } from "@vibestudio/workspace-contracts/clients";
import { CliError, UsageError } from "../../src/cli/output.js";

/** Conventional exit status for a SIGINT-terminated command. */
export const EXIT_INTERRUPTED = 130;

/**
 * A revision that moves when the server says something a waiting launch may
 * be waiting for. The launch gate waits on it instead of asking again on a
 * timer: nothing here is polled.
 */
export class ChangeSignal {
  private current = 0;
  private readonly waiters = new Set<() => void>();

  revision(): number {
    return this.current;
  }

  bump(): void {
    this.current += 1;
    for (const wake of [...this.waiters]) wake();
  }

  /** Resolves when the revision moves past `after`; rejects when `signal` aborts. */
  wait(after: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.current !== after) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(wake);
        reject(signal!.reason);
      };
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export interface ClientLaunchGateOptions {
  select: ClientSelection;
  /** Approve each startup approval once without prompting. */
  yes?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Concise progress lines (build/activation status) for the user. */
  onProgress?(line: string): void;
  /**
   * The owner's termination request. It ends an open approval prompt and the
   * wait for the server, so a hang-up or SIGTERM never leaves the prompt
   * holding the terminal after the server it asks about is gone.
   */
  signal?: AbortSignal;
  /** Server events that may move a `preparing` launch on. */
  changes: ChangeSignal;
}

export type ClientLaunchOutcome =
  | { status: "ready"; launched: LaunchedClient; approvalsResolved: number }
  | { status: "denied"; approvalsResolved: number }
  | {
      status: "unavailable";
      reason: string;
      missing?: { capabilities?: string[]; hostAbi?: string };
      approvalsResolved: number;
    };

function describePreparing(state: Extract<LaunchState, { state: "preparing" }>): string {
  return state.reason;
}

/**
 * Resolve, approve and deliver a client before it takes the terminal. The
 * launch itself is the core's state machine; this is its terminal front:
 * approval prompts are line-mode questions on the real terminal that stay
 * open until answered, and a `preparing` launch waits for the server's own
 * events (`clients:changed`, `supervision:changed`, approval changes).
 */
export async function runClientLaunchGate(
  launcher: ClientLauncher,
  options: ClientLaunchGateOptions
): Promise<ClientLaunchOutcome> {
  const output = options.output ?? process.stdout;
  let approvalsResolved = 0;
  let lastProgress = "";
  let seen = options.changes.revision();
  options.signal?.throwIfAborted();
  let state = await launcher.launch(options.select);
  for (;;) {
    options.signal?.throwIfAborted();
    switch (state.state) {
      case "ready":
        return { status: "ready", launched: state.launched, approvalsResolved };
      case "unavailable":
        return {
          status: "unavailable",
          reason: state.reason,
          ...(state.missing ? { missing: state.missing } : {}),
          approvalsResolved,
        };
      case "approval-required": {
        output.write(
          `\n${formatLaunchGateForTerminal(state.approvals, "terminal", width(output))}\n\n`
        );
        const decision = await getDecision(state.approvals, options);
        seen = options.changes.revision();
        const next = await launcher.resolveApprovals(state.approvals, decision);
        if (decision === "deny" || !next) return { status: "denied", approvalsResolved };
        approvalsResolved += state.approvals.length;
        lastProgress = "";
        state = next;
        continue;
      }
      case "preparing": {
        const line = describePreparing(state);
        if (line !== lastProgress) {
          options.onProgress?.(line);
          lastProgress = line;
        }
        await options.changes.wait(seen, options.signal);
        seen = options.changes.revision();
        state = (await launcher.onClientsChanged()) ?? state;
        continue;
      }
    }
  }
}

function width(output: NodeJS.WriteStream): number {
  return Math.max(40, Math.min(output.columns ?? 80, 100));
}

async function getDecision(
  approvals: PendingUnitInstallReviewApproval[],
  options: ClientLaunchGateOptions
): Promise<BootstrapDecision> {
  if (options.yes) return "once";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError(
      `${hostLabel("terminal")} startup needs your approval, but this is not an interactive ` +
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

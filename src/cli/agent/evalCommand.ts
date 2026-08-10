/**
 * `vibestudio eval ...` — run TypeScript/JavaScript server-side in the CLI
 * session's EvalDO, via the `eval` service. The paired shell credential is the
 * transport identity, but the eval owner is the selected agent session entity
 * so persistent REPL scope + fs/git/vcs are bound to that session's context.
 *
 * Code sources: FILE positional, `-e CODE`, or `-` (stdin); or `--path` to run
 * a context-relative file the server reads itself.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createEvalExecutor, evalMethods } from "@vibestudio/service-schemas/eval";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { evalRuntimeId } from "@vibestudio/shared/evalRuntimeIdentity";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import {
  jsonMode,
  printError,
  printResult,
  CliError,
  TimeoutError,
  UsageError,
} from "../output.js";
import { typedClient } from "../typedClients.js";
import { resolveSessionScope, SCOPE_FLAGS } from "./sessionContext.js";
import { createEvalAutoApprover, parseEvalApprovalLevel } from "./evalAutoApproval.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the inline code for a run, or `undefined` when `--path` is used (the
 * server reads the file from the session's context). FILE / `-e CODE` / stdin
 * are mutually exclusive with each other and with `--path`.
 */
async function resolveCode(
  inv: ParsedInvocation,
  serverPath: string | undefined
): Promise<string | undefined> {
  const inline = typeof inv.flags["code"] === "string" ? inv.flags["code"] : undefined;
  const file = inv.positionals[0];
  const sources = [inline !== undefined, file !== undefined, serverPath !== undefined].filter(
    Boolean
  ).length;
  if (sources > 1) {
    throw new UsageError("choose one of: FILE, -e CODE, stdin (-), or --path");
  }
  if (serverPath !== undefined) return undefined;
  if (inline !== undefined) return inline;
  if (file === "-" || file === undefined) {
    if (file === undefined && process.stdin.isTTY) {
      throw new UsageError("missing code: pass FILE, -e CODE, --path, or pipe code via stdin");
    }
    return await readStdin();
  }
  return await fs.promises.readFile(file, "utf8");
}

function parseTimeout(inv: ParsedInvocation): number | undefined {
  const raw = inv.flags["timeout"];
  // Default: unbounded. The CLI follows the EvalDO run without an implicit client cap.
  // `--timeout` opts into BOTH a server-side abort
  // (the EvalDO honors `timeoutMs`) and a local wait cap (exit 4 if the server doesn't respond).
  if (typeof raw !== "string") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError("--timeout must be a positive integer (milliseconds)");
  }
  return value;
}

function parseImports(inv: ParsedInvocation): Record<string, string> | undefined {
  const raw = inv.flags["imports"];
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError('--imports must be a JSON object, e.g. {"lodash":"npm:4"}');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--imports must be a JSON object");
  }
  return parsed as Record<string, string>;
}

function parseSyntax(
  inv: ParsedInvocation
): "javascript" | "typescript" | "jsx" | "tsx" | undefined {
  const raw = inv.flags["syntax"];
  if (typeof raw !== "string") return undefined;
  if (raw !== "javascript" && raw !== "typescript" && raw !== "jsx" && raw !== "tsx") {
    throw new UsageError("--syntax must be one of: javascript, typescript, jsx, tsx");
  }
  return raw;
}

/**
 * Race an eval RPC against the local timeout. The server keeps running the
 * eval if the deadline trips — the CLI just stops waiting and reports a
 * timeout (exit 4), preserving the previous `--timeout` contract.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new TimeoutError(`eval timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// eval run
// ---------------------------------------------------------------------------

async function evalRun(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const serverPath = typeof inv.flags["path"] === "string" ? inv.flags["path"] : undefined;
    const code = await resolveCode(inv, serverPath);
    const timeoutMs = parseTimeout(inv);
    const approvalLevel = parseEvalApprovalLevel(inv.flags["approval-level"]);
    const imports = parseImports(inv);
    const syntax = parseSyntax(inv);
    // Scope (credential + context + owner identity) is fully resolved by
    // resolveSessionScope — including the agent-token path, which has no device
    // credential or workspace selection to validate here.
    const { client, session } = resolveSessionScope(inv);

    const evalClient = typedClient("eval", evalMethods, client);
    const scopeKey = session.scopeKey;

    const runArgs = {
      runId: randomUUID(),
      target: { kind: "owner-session" as const, sessionId: session.entityId },
      scope: { key: scopeKey },
      source:
        serverPath !== undefined
          ? { kind: "context-file" as const, path: serverPath, syntax }
          : { kind: "inline" as const, code: code!, syntax },
      imports,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    let streamedConsole = "";
    let lastShellWaitDiagnostic = "";
    let activeAuthorityDiagnostic = "";
    let authorityDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;
    let stopLiveEvents: (() => Promise<void>) | undefined;
    let rejectAutoApproval!: (error: unknown) => void;
    const autoApprovalFailure = new Promise<never>((_resolve, reject) => {
      rejectAutoApproval = reject;
    });
    const approvals = typedClient("shellApproval", shellApprovalMethods, client);
    const autoApprover = createEvalAutoApprover({
      level: approvalLevel,
      runId: runArgs.runId,
      callerId: evalRuntimeId(session.entityId, scopeKey),
      resolve: (approvalId, decision) => approvals.resolve(approvalId, decision),
      onApproved: ({ capability, tier, decision }) => {
        process.stderr.write(
          `eval ${runArgs.runId} auto-approved ${tier} ${capability} for ${decision}\n`
        );
      },
      onError: rejectAutoApproval,
    });
    {
      const events = new EventsClient(client);
      const removeApprovalListener = events.on("shell-approval:pending-changed", ({ pending }) => {
        autoApprover.observePending(pending);
        for (const approval of pending) {
          const capability =
            approval.kind === "capability"
              ? ` ${approval.capability} (${approval.cardType ?? approval.severity ?? "unclassified"})`
              : "";
          const lineage =
            approval.kind === "capability" && approval.snapshot
              ? ` task ${approval.snapshot.taskRef ?? "-"}/${approval.snapshot.taskAuthority ?? "-"}` +
                ` decisions [${approval.allowedDecisions?.join(", ") ?? "-"}]` +
                ` initiated by [${approval.snapshot.initiatorChain.join(", ")}]`
              : "";
          const diagnostic =
            `CLI operation is waiting for ${approval.kind} approval ${approval.approvalId}` +
            `${capability} from ${approval.callerId}${lineage}`;
          if (diagnostic === lastShellWaitDiagnostic) continue;
          lastShellWaitDiagnostic = diagnostic;
          process.stderr.write(`${diagnostic}\n`);
        }
      });
      const removeListener = events.on("eval:run-event", (payload) => {
        if (payload.runId !== runArgs.runId || payload.scopeKey !== scopeKey) return;
        if (payload.event.kind === "authority-requested") {
          const detail =
            payload.event.payload && typeof payload.event.payload === "object"
              ? (payload.event.payload as Record<string, unknown>)
              : {};
          autoApprover.observeAuthorityRequested(detail);
          const capability =
            typeof detail["capability"] === "string" ? ` ${detail["capability"]}` : "";
          const acquisition =
            typeof detail["acquisitionId"] === "string" ? ` (${detail["acquisitionId"]})` : "";
          const diagnostic = `eval ${runArgs.runId} is waiting for approval${capability}${acquisition}`;
          if (authorityDiagnosticTimer) clearTimeout(authorityDiagnosticTimer);
          authorityDiagnosticTimer = setTimeout(() => {
            activeAuthorityDiagnostic = diagnostic;
            process.stderr.write(`${diagnostic}\n`);
          }, 500);
          authorityDiagnosticTimer.unref?.();
          return;
        }
        if (payload.event.kind === "authority-decided") {
          autoApprover.observeAuthorityDecided(payload.event.payload);
          if (authorityDiagnosticTimer) clearTimeout(authorityDiagnosticTimer);
          authorityDiagnosticTimer = undefined;
          if (activeAuthorityDiagnostic) {
            process.stderr.write(`eval ${runArgs.runId} approval decided; resuming\n`);
            activeAuthorityDiagnostic = "";
          }
          return;
        }
        if (json || payload.event.kind !== "console") return;
        const eventPayload = payload.event.payload;
        const text =
          eventPayload && typeof eventPayload === "object" && !Array.isArray(eventPayload)
            ? (eventPayload as Record<string, unknown>)["text"]
            : undefined;
        if (typeof text !== "string" || text.length === 0) return;
        streamedConsole += text;
        process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
      });
      try {
        await events.subscribeAll(["eval:run-event", "shell-approval:pending-changed"]);
        if (approvalLevel > 0) autoApprover.observePending(await approvals.listPending());
        stopLiveEvents = async () => {
          removeListener();
          removeApprovalListener();
          if (authorityDiagnosticTimer) clearTimeout(authorityDiagnosticTimer);
          const unsubscribe = events.unsubscribeAll();
          await client.close();
          await unsubscribe;
        };
      } catch {
        // Live observation is an ergonomic accelerator. The durable executor
        // remains authoritative if a watch cannot be established.
        removeListener();
        removeApprovalListener();
      }
    }
    const abort = new AbortController();
    const executeEval = createEvalExecutor(
      <T>(method: string, args: unknown[]) => client.call<T>(method, args),
      { signal: abort.signal }
    );
    let result;
    try {
      // --fresh-scope wipes the persistent scope (and user db) before the run,
      // so the snippet starts empty. The event watch is already active so an
      // approval wait cannot look like a dead CLI request.
      if (inv.flags["fresh-scope"] === true) {
        await evalClient.reset({
          target: { kind: "owner-session", sessionId: session.entityId },
          scopeKey,
        });
      }
      const execution = executeEval(runArgs);
      const observedExecution =
        approvalLevel === 0 ? execution : Promise.race([execution, autoApprovalFailure]);
      result =
        timeoutMs !== undefined
          ? await withTimeout(observedExecution, timeoutMs, () =>
              abort.abort(new TimeoutError(`eval timed out after ${timeoutMs}ms`))
            )
          : await observedExecution;
    } finally {
      await stopLiveEvents?.();
    }

    if (json) {
      printResult(result, { json: true });
      return result.success ? 0 : 1;
    }

    // Text mode: stream captured console first, then the return value (or error).
    if (result.console && result.console !== streamedConsole) {
      const remaining = result.console.startsWith(streamedConsole)
        ? result.console.slice(streamedConsole.length)
        : result.console;
      if (remaining) process.stderr.write(remaining.endsWith("\n") ? remaining : `${remaining}\n`);
    }
    if (!result.success) {
      throw new CliError(result.error ?? "eval failed");
    }
    if (result.returnValue !== undefined) {
      printResult(result.returnValue, { json: false });
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

// ---------------------------------------------------------------------------
// eval repl-reset
// ---------------------------------------------------------------------------

async function evalReplReset(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, session } = resolveSessionScope(inv);
    const evalClient = typedClient("eval", evalMethods, client);
    const result = await evalClient.reset({
      target: { kind: "owner-session", sessionId: session.entityId },
      scopeKey: session.scopeKey,
    });
    printResult(result, {
      json,
      human: () => console.log(`scope reset for session ${session.name}`),
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    return printError(error, { json });
  }
}

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

export const evalCommands: CliCommand[] = [
  {
    group: "eval",
    name: "run",
    summary: "Run TS/JS server-side in the session's eval sandbox",
    usage:
      "vibestudio eval run [FILE | -e CODE | - | --path P] [--timeout MS] [--approval-level 0|1|2] [--fresh-scope]",
    flags: [
      { name: "code", short: "e", takesValue: true, description: "Inline code" },
      { name: "path", takesValue: true, description: "Context-relative file the server runs" },
      {
        name: "timeout",
        takesValue: true,
        description: "Stop waiting after MS (unbounded when omitted)",
      },
      {
        name: "fresh-scope",
        takesValue: false,
        description: "Reset the REPL scope before running",
      },
      {
        name: "approval-level",
        takesValue: true,
        description: "0=prompt, 1=auto-approve gated, 2=auto-approve gated and critical",
      },
      {
        name: "syntax",
        takesValue: true,
        description: "javascript | typescript | jsx | tsx (default tsx)",
      },
      {
        name: "imports",
        takesValue: true,
        description: 'JSON imports map, e.g. {"lodash":"npm:4"}',
      },
      ...SCOPE_FLAGS,
      JSON_FLAG,
    ],
    run: evalRun,
  },
  {
    group: "eval",
    name: "repl-reset",
    summary: "Reset the persistent REPL scope for a session",
    usage: "vibestudio eval repl-reset [--session NAME]",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: evalReplReset,
  },
];

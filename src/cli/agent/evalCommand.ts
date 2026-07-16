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
import { evalMethods, evalStartInputSchema } from "@vibestudio/service-schemas/eval";
import { executeEval } from "@vibestudio/service-schemas/clients/evalClient";
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
  // Default: unbounded. The eval runs server-held in the EvalDO (workerd does not cap a held
  // request), so there is no implicit client cap. `--timeout` opts into BOTH a server-side abort
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

function parseJsonArrayFlag(inv: ParsedInvocation, name: string): unknown[] | undefined {
  const raw = inv.flags[name];
  if (typeof raw !== "string") return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) throw new Error("expected an array");
    return value;
  } catch (error) {
    throw new UsageError(
      `--${name} must be a JSON array: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
 * Race lifecycle observation against the local timeout. The same deadline is
 * persisted with the run, and aborting observation immediately requests
 * cooperative server-side cancellation before the CLI reports exit 4.
 */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(
        new TimeoutError(
          `eval timed out after ${timeoutMs}ms; cooperative cancellation was requested`
        )
      );
    }, timeoutMs);
    run(controller.signal).then(
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
    const imports = parseImports(inv);
    const requests = parseJsonArrayFlag(inv, "requests");
    const preauthorize = parseJsonArrayFlag(inv, "preauthorize");
    const syntax = parseSyntax(inv);
    // Scope (credential + context + owner identity) is fully resolved by
    // resolveSessionScope — including the agent-token path, which has no device
    // credential or workspace selection to validate here.
    const { client, contextId, session } = resolveSessionScope(inv);

    const evalClient = typedClient("eval", evalMethods, client);
    const subKey = session.scopeKey;

    const runArgs = evalStartInputSchema.parse({
      target: {
        kind: "attached-session" as const,
        ownerId: session.entityId,
        contextId,
      },
      scope: {
        key: subKey,
        ...(inv.flags["fresh-scope"] === true ? { reset: true } : {}),
      },
      source:
        serverPath !== undefined
          ? { kind: "context-file" as const, path: serverPath, syntax }
          : { kind: "inline" as const, code: code ?? "", syntax },
      imports,
      ...(timeoutMs !== undefined ? { deadlineMs: timeoutMs } : {}),
      ...(typeof inv.flags["idempotency-key"] === "string"
        ? { idempotencyKey: inv.flags["idempotency-key"] }
        : {}),
      authority: {
        ...(inv.flags["strict"] === true || requests
          ? { mode: "strict" as const, requests: requests ?? [] }
          : {}),
        ...(inv.flags["read-only"] === true ? { effects: "read-only" as const } : {}),
        ...(inv.flags["pregranted-only"] === true ? { approvals: "pregranted-only" as const } : {}),
        ...(preauthorize ? { preauthorize } : {}),
      },
    });
    const result =
      timeoutMs !== undefined
        ? await withTimeout((signal) => executeEval(evalClient, runArgs, { signal }), timeoutMs)
        : await executeEval(evalClient, runArgs);

    if (json) {
      printResult(result, { json: true });
      return result.success ? 0 : 1;
    }

    // Text mode: stream captured console first, then the return value (or error).
    if (result.console)
      process.stderr.write(result.console.endsWith("\n") ? result.console : `${result.console}\n`);
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
    const { client, contextId, session } = resolveSessionScope(inv);
    const evalClient = typedClient("eval", evalMethods, client);
    const result = await evalClient.reset({
      target: { kind: "attached-session", ownerId: session.entityId, contextId },
      scope: { key: session.scopeKey },
    });
    printResult(result, {
      json,
      human: () => console.log(`scope reset for session ${session.name}`),
    });
    return result.status === "reset" ? 0 : 1;
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
    usage: "vibestudio eval run [FILE | -e CODE | - | --path P] [--timeout MS] [--fresh-scope]",
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
        name: "read-only",
        takesValue: false,
        description: "Allow only methods canonically declared as reads",
      },
      {
        name: "strict",
        takesValue: false,
        description: "Use an exact strict authority envelope (empty unless --requests is supplied)",
      },
      {
        name: "requests",
        takesValue: true,
        description: "JSON capability-scope array for strict mode",
      },
      {
        name: "preauthorize",
        takesValue: true,
        description: "JSON canonical call-intent array to approve before code starts",
      },
      {
        name: "idempotency-key",
        takesValue: true,
        description: "Return the same handle for an equivalent lost-response retry",
      },
      {
        name: "pregranted-only",
        takesValue: false,
        description: "Never prompt; return a structured missing-grant error",
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

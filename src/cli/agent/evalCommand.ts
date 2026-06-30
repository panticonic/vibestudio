/**
 * `vibez1 eval ...` — run TypeScript/JavaScript server-side in the CLI
 * session's EvalDO, via the `eval` service. The paired shell credential is the
 * transport identity, but the eval owner is the selected agent session entity
 * so persistent REPL scope + fs/git/vcs are bound to that session's context.
 *
 * Code sources: FILE positional, `-e CODE`, or `-` (stdin); or `--path` to run
 * a context-relative file the server reads itself.
 */
import * as fs from "node:fs";
import { evalMethods } from "@vibez1/shared/serviceSchemas/eval";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import { loadCliCredentials } from "../credentialStore.js";
import {
  jsonMode,
  printError,
  printResult,
  CliError,
  TimeoutError,
  UsageError,
} from "../output.js";
import { typedClient } from "../typedClients.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";

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

function parseSyntax(inv: ParsedInvocation): "typescript" | "jsx" | "tsx" | undefined {
  const raw = inv.flags["syntax"];
  if (typeof raw !== "string") return undefined;
  if (raw !== "typescript" && raw !== "jsx" && raw !== "tsx") {
    throw new UsageError("--syntax must be one of: typescript, jsx, tsx");
  }
  return raw;
}

/**
 * Race an eval RPC against the local timeout. The server keeps running the
 * eval if the deadline trips — the CLI just stops waiting and reports a
 * timeout (exit 4), preserving the previous `--timeout` contract.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`eval timed out after ${timeoutMs}ms (still running server-side)`));
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
    const imports = parseImports(inv);
    const syntax = parseSyntax(inv);
    const { client, contextId, session } = resolveSessionScope(inv);
    const creds = loadCliCredentials();
    if (!creds) throw new CliError("not paired");
    if (!creds.workspaceName) throw new CliError("no remote workspace selected");

    const evalClient = typedClient("eval", evalMethods, client);
    const subKey = session.scopeKey;

    // --fresh-scope wipes the persistent scope (and user db) before the run, so
    // the snippet starts from an empty REPL scope.
    if (inv.flags["fresh-scope"] === true) {
      await evalClient.reset({ ownerId: session.entityId, contextId, subKey });
    }

    const runArgs = {
      ownerId: session.entityId,
      contextId,
      subKey,
      code,
      path: serverPath,
      syntax,
      imports,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const result =
      timeoutMs !== undefined
        ? await withTimeout(evalClient.run(runArgs), timeoutMs)
        : await evalClient.run(runArgs);

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
      ownerId: session.entityId,
      contextId,
      subKey: session.scopeKey,
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
    usage: "vibez1 eval run [FILE | -e CODE | - | --path P] [--timeout MS] [--fresh-scope]",
    flags: [
      { name: "code", short: "e", takesValue: true, description: "Inline code" },
      { name: "path", takesValue: true, description: "Context-relative file the server runs" },
      {
        name: "timeout",
        takesValue: true,
        description: "Stop waiting after MS (default 120000)",
      },
      {
        name: "fresh-scope",
        takesValue: false,
        description: "Reset the REPL scope before running",
      },
      { name: "syntax", takesValue: true, description: "typescript | jsx | tsx (default tsx)" },
      {
        name: "imports",
        takesValue: true,
        description: 'JSON imports map, e.g. {"lodash":"npm:4"}',
      },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: evalRun,
  },
  {
    group: "eval",
    name: "repl-reset",
    summary: "Reset the persistent REPL scope for a session",
    usage: "vibez1 eval repl-reset [--session NAME]",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: evalReplReset,
  },
];

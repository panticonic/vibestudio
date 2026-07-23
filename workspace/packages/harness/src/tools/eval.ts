/**
 * Eval tool — runs code in the agent's own server-side EvalDO via the `eval` service
 * (owner = the agent's verified identity). Replaces the former panel-advertised `eval`
 * channel method: it's a LOCAL agent tool, so the loop dispatches it in-process (the
 * EvalDO runs the code, not the panel). REPL scope + a synchronous SQLite `db` persist
 * in the EvalDO across calls.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

const evalCommonSchema = {
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Optional wall-clock deadline in milliseconds for this run. Omit it for no deadline; set it when work may stall or must finish within a known bound.",
    })
  ),
  reset: Type.Optional(
    Type.Boolean({
      description:
        "Clear this agent/channel sandbox scope and user db atomically before executing this call. Use this for reset lifecycle work; do not call eval.reset from inside eval code.",
    })
  ),
  syntax: Type.Optional(
    Type.Union(
      [
        Type.Literal("javascript"),
        Type.Literal("typescript"),
        Type.Literal("jsx"),
        Type.Literal("tsx"),
      ],
      {
        description:
          'Parser mode (default: "tsx"). Omit this for TypeScript/TSX. Select "javascript" only for plain JavaScript with no type annotations, `as` assertions, interfaces, or other TypeScript syntax.',
      }
    )
  ),
  imports: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'On-demand packages, e.g. { "lodash": "npm:^4.17.21" }. Workspace packages auto-resolve from the current context; omit them or use "workspace:*". Explicit workspace pins are "main", "ctx:<contextId>", or "state:<stateHash>".',
    })
  ),
};

const evalSchema = Type.Union(
  [
    Type.Object(
      {
        ...evalCommonSchema,
        code: Type.String({
          description: "TypeScript/JavaScript to execute in the sandbox.",
        }),
        path: Type.Optional(
          Type.String({
            description:
              "Optional context-relative source file or directory hint for inline code; relative imports resolve from it.",
          })
        ),
        sourcePath: Type.Optional(
          Type.String({
            description:
              "Optional context-relative virtual filename for inline code; relative imports resolve from it.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...evalCommonSchema,
        path: Type.String({
          description: "Context-relative .ts/.tsx file to execute instead of inline code.",
        }),
        sourcePath: Type.Optional(Type.Never()),
        code: Type.Optional(Type.Never()),
      },
      { additionalProperties: false }
    ),
  ],
  {
    description:
      "Execute inline code or a context-relative file. Inline code may include a sourcePath/path hint for relative imports.",
  }
);

export type EvalToolInput = Static<typeof evalSchema>;

export interface EvalRunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  failureKind?: "user-code" | "infrastructure" | "cancelled";
  failureCode?: string;
  scopeKeys?: string[];
}

export interface NormalizedEvalToolSource {
  code?: string;
  path?: string;
  sourcePath?: string;
}

const EXECUTABLE_EVAL_PATH = /\.(?:[cm]js|[cm]ts|jsx|tsx)$/i;

/** Shared by the immediate tool and AgentVessel's deferred eval gate. */
export function normalizeEvalToolSource(params: {
  code?: unknown;
  path?: unknown;
  sourcePath?: unknown;
  syntax?: "javascript" | "typescript" | "jsx" | "tsx";
}): NormalizedEvalToolSource {
  const path =
    typeof params.path === "string" && params.path.trim() ? params.path.trim() : undefined;
  const explicitSourcePath =
    typeof params.sourcePath === "string" && params.sourcePath.trim()
      ? params.sourcePath.trim()
      : undefined;
  if (params.code !== undefined && typeof params.code !== "string") {
    throw new Error("eval code must be a string");
  }
  const code = typeof params.code === "string" ? params.code : undefined;
  if (code === undefined && path === undefined) {
    throw new Error("eval requires code or path");
  }
  // File-backed eval is also a useful loader for documents/data. Parsing a
  // Markdown/JSON/YAML/text path as TS produces a noisy syntax failure and is
  // never useful; load it through the same context-scoped runtime fs instead.
  if (code === undefined && path !== undefined && !EXECUTABLE_EVAL_PATH.test(path)) {
    return {
      code: `return await fs.readFile(${JSON.stringify(path)}, "utf8");`,
    };
  }
  return {
    code,
    path: code === undefined ? path : undefined,
    sourcePath:
      code !== undefined
        ? (explicitSourcePath ?? (path ? inlineSourcePathFromHint(path, params.syntax) : undefined))
        : undefined,
  };
}

/**
 * Format an `EvalRunResult` into the agent-visible tool result (windowing large console/return so a
 * runaway eval can't blow the agent's context). Shared by the tool's synchronous `execute` and the
 * agent's DEFERRED resume (`onEvalComplete`), so both produce identical output.
 */
export function formatEvalResult(result: EvalRunResult): AgentToolResult<EvalRunResult> {
  const parts: string[] = [];
  if (!result.success) parts.push(`[eval] Error: ${result.error ?? "unknown error"}`);
  if (result.console) {
    parts.push(`[eval] Console:\n${clampText(result.console, MAX_CONSOLE_CHARS, "$lastConsole")}`);
  }
  if (result.success && result.returnValue !== undefined) {
    parts.push(
      `[eval] Return value:\n${clampText(safeStringify(result.returnValue), MAX_RETURN_CHARS, "$lastReturn")}`
    );
  }
  const keys = result.scopeKeys ?? [];
  parts.push(
    keys.length ? `[scope] keys: ${keys.join(", ")} (${keys.length} total)` : "[scope] (empty)"
  );
  return {
    content: [{ type: "text", text: parts.join("\n") || "[eval] (no output)" }],
    details: result,
  } as AgentToolResult<EvalRunResult>;
}

export function createEvalTool(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>,
  opts: { subKey?: string } = {}
): AgentTool<typeof evalSchema> {
  return {
    name: "eval",
    label: "eval",
    description:
      "Execute TypeScript/JS in your persistent sandbox (a per-agent EvalDO, not the visible panel). Calls have no implicit wall deadline; pass a positive integer timeoutMs when work may stall or must finish within a known bound. Split intentionally bounded workflows when useful and persist intermediate state in `scope` or `db`. REPL scope persists across calls via `scope`; a synchronous in-DO SQLite `db` is available. Set reset:true to clear scope/db atomically before this call; never call eval.reset from inside the running eval. The live runtime is self-describing: call `await help()` to list bindings or `await help(\"workers\")` (and the analogous binding name) before guessing an API or return shape. Call workspace services via `rpc`/`services`; `chat.channelId` is only the channel where this agent is responding; for visible panel perspective use `parent`/`getParent()` and `panelTree` plus target panel stateArgs. `return` sends a bounded value back; console output is captured. Very large console/return payloads are windowed with recovery pointers to `scope.$lastConsole` / `scope.$lastReturn`, so prefer compact summaries and store large artifacts in scope/blobstore.",
    parameters: evalSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<EvalRunResult>> => {
      // Some model transports materialize an optional string as "". Treat an
      // empty path as omitted when inline code is present; it is never a valid
      // context-relative file and should not turn an otherwise valid eval into
      // a mutually-exclusive-arguments error.
      const source = normalizeEvalToolSource(params);
      const result = await callMain<EvalRunResult>("eval.run", [
        {
          subKey: opts.subKey,
          // The agent's eval subKey IS its channelId — thread it through so the
          // service can give the sandbox a `chat` binding proxied to this agent.
          channelId: opts.subKey,
          reset: params.reset,
          timeoutMs: params.timeoutMs,
          ...source,
          syntax: params.syntax,
          imports: params.imports,
        },
      ]);
      // Formatting (with large-output windowing) is shared with the agent's deferred resume.
      return formatEvalResult(result);
    },
  };
}

function inlineSourcePathFromHint(
  hint: string,
  syntax: "javascript" | "typescript" | "jsx" | "tsx" | undefined
): string {
  if (/\.[cm]?[jt]sx?$/iu.test(hint)) return hint;
  const base = hint.replace(/\/+$/u, "");
  const extension =
    syntax === "javascript"
      ? "js"
      : syntax === "jsx"
        ? "jsx"
        : syntax === "typescript"
          ? "ts"
          : "tsx";
  return `${base}/__inline_eval__.${extension}`;
}

// Catastrophe safety-net ONLY — a runaway eval that returns hundreds of KB
// would blow the agent's context or trip the RPC body cap. These are deliberately
// generous (~25k tokens/section): normal grep/typecheck/diagnostic output passes
// through untouched; only pathological dumps are windowed. (The richer original
// behavior — spill to blobstore/scope — is a separate follow-up.)
const MAX_CONSOLE_CHARS = 100_000;
const MAX_RETURN_CHARS = 100_000;

/**
 * Window to `max` chars (head+tail) with an actionable notice of how much was
 * elided and where to recover the full value: `scopeKey` is the persistent-scope
 * key the EvalDO stashed a bounded full copy under, page/grep it in a follow-up eval.
 */
function clampText(text: string, max: number, scopeKey: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const elided = text.length - max;
  return (
    `${text.slice(0, head)}\n` +
    `…[eval output truncated — ${elided} of ${text.length} chars elided. The full value is in ` +
    `\`scope.${scopeKey}\` — read it in pages (e.g. \`return scope.${scopeKey}.slice(0, 40000)\`) ` +
    `or grep it. Or narrow the eval.]…\n` +
    `${text.slice(-tail)}`
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

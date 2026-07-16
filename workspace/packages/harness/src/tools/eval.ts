/**
 * Eval tool — runs code in the agent's own server-side EvalDO via the `eval` service
 * (owner = the agent's verified identity). Replaces the former panel-advertised `eval`
 * channel method: it's a LOCAL agent tool, so the loop dispatches it in-process (the
 * EvalDO runs the code, not the panel). REPL scope + a synchronous SQLite `db` persist
 * in the EvalDO across calls.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  executeEval as executeEvalLifecycle,
  type EvalClientTransport,
} from "@vibestudio/service-schemas/clients/evalClient";
import {
  evalStartInputSchema,
  type EvalRunResult,
  type EvalStartInput,
} from "@vibestudio/service-schemas/eval";

export type { EvalRunResult } from "@vibestudio/service-schemas/eval";

const evalCommonSchema = {
  idempotencyKey: Type.Optional(
    Type.String({
      description: "Stable key for safe lost-response retry of the same normalized run.",
    })
  ),
  deadlineMs: Type.Optional(
    Type.Integer({ minimum: 1, description: "Optional cooperative host deadline in milliseconds." })
  ),
  reset: Type.Optional(
    Type.Boolean({
      description:
        "Clear this agent/channel sandbox scope and user db atomically before executing this call. Use this for reset lifecycle work; do not call eval.reset or eval.forceReset from inside eval code.",
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
      { description: "Source syntax (default: tsx)." }
    )
  ),
  imports: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'On-demand packages, e.g. { "lodash": "npm:^4.17.21" }. Workspace packages auto-resolve from the current context; omit them or use "workspace:*". Explicit workspace pins are "main", "ctx:<contextId>", or "state:<stateHash>".',
    })
  ),
  authority: Type.Optional(
    Type.Object(
      {
        mode: Type.Optional(Type.Union([Type.Literal("adaptive"), Type.Literal("strict")])),
        effects: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("mutable")])),
        approvals: Type.Optional(
          Type.Union([Type.Literal("prompt"), Type.Literal("pregranted-only")])
        ),
        requests: Type.Optional(
          Type.Array(
            Type.Object({
              capability: Type.String(),
              resource: Type.Union([
                Type.Object({ kind: Type.Literal("exact"), key: Type.String() }),
                Type.Object({ kind: Type.Literal("prefix"), prefix: Type.String() }),
                Type.Object({ kind: Type.Literal("origin"), origin: Type.String() }),
                Type.Object({ kind: Type.Literal("domain"), domain: Type.String() }),
                Type.Object({ kind: Type.Literal("network"), value: Type.Literal("*") }),
              ]),
            })
          )
        ),
        preauthorize: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Object(
                {
                  plane: Type.Literal("host-service"),
                  method: Type.String(),
                  args: Type.Array(Type.Unknown()),
                },
                { additionalProperties: false }
              ),
              Type.Object(
                {
                  plane: Type.Literal("workspace-do"),
                  target: Type.Object(
                    {
                      source: Type.String(),
                      className: Type.String(),
                      objectKey: Type.String(),
                    },
                    { additionalProperties: false }
                  ),
                  method: Type.String(),
                  args: Type.Array(Type.Unknown()),
                },
                { additionalProperties: false }
              ),
            ])
          )
        ),
      },
      {
        additionalProperties: false,
        description:
          "Optional containment. Omit for adaptive mutable eval with dynamic approval; use strict/read-only/pregranted-only for deliberate confinement.",
      }
    )
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

export function evalStartInput(
  source: NormalizedEvalToolSource,
  params: {
    reset?: boolean;
    syntax?: "javascript" | "typescript" | "jsx" | "tsx";
    imports?: Record<string, string>;
    authority?: unknown;
    idempotencyKey?: string;
    deadlineMs?: number;
  },
  subKey: string | undefined
): EvalStartInput {
  return evalStartInputSchema.parse({
    source:
      source.code !== undefined
        ? {
            kind: "inline",
            code: source.code,
            pathHint: source.sourcePath,
            syntax: params.syntax,
          }
        : { kind: "context-file", path: source.path, syntax: params.syntax },
    scope: { key: subKey ?? "default", ...(params.reset ? { reset: true } : {}) },
    ...(subKey ? { channelId: subKey } : {}),
    imports: params.imports,
    authority: params.authority,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.deadlineMs ? { deadlineMs: params.deadlineMs } : {}),
  });
}

async function executeEval(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>,
  input: EvalStartInput
): Promise<EvalRunResult> {
  const client: EvalClientTransport = {
    start: (request) => callMain("eval.start", [request]),
    get: (request) => callMain("eval.get", [request]),
    events: (request) => callMain("eval.events", [request]),
    cancel: (request) => callMain("eval.cancel", [request]),
  };
  return executeEvalLifecycle(client, input);
}

export interface NormalizedEvalToolSource {
  code?: string;
  path?: string;
  sourcePath?: string;
}

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
  if (!result.success) {
    parts.push(
      `[eval] Error${result.errorCode ? ` (${result.errorCode})` : ""}: ${result.error ?? "unknown error"}`
    );
  }
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
      "Execute TypeScript/JS in your persistent sandbox (a per-agent EvalDO, not the visible panel). REPL scope persists across calls via `scope`; a synchronous in-DO SQLite `db` is available. Set reset:true to clear scope/db atomically before this call; never call eval.reset or eval.forceReset from inside the running eval. Call workspace services via `rpc`/`services`; `chat.channelId` is only the channel where this agent is responding; for visible panel perspective use `parent`/`getParent()` and `panelTree` plus target panel stateArgs. `return` sends a bounded value back; console output is captured. Very large console/return payloads are windowed with recovery pointers to `scope.$lastConsole` / `scope.$lastReturn`, so prefer compact summaries and store large artifacts in scope/blobstore.",
    parameters: evalSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<EvalRunResult>> => {
      // Some model transports materialize an optional string as "". Treat an
      // empty path as omitted when inline code is present; it is never a valid
      // context-relative file and should not turn an otherwise valid eval into
      // a mutually-exclusive-arguments error.
      const source = normalizeEvalToolSource(params);
      const result = await executeEval(callMain, evalStartInput(source, params, opts.subKey));
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

/**
 * Shared eval tool definition builder.
 *
 * Both the panel eval tool and the headless eval tool use this to build
 * identical eval method definitions. One implementation, consistent behavior.
 */
import { z } from "zod";
import { executeSandbox as defaultExecuteSandbox } from "@workspace/eval";
import type { SandboxOptions, SandboxResult, ScopeManager } from "@workspace/eval";
import type { MethodDefinition, MethodExecutionContext } from "@workspace/pubsub";
import type { SandboxConfig, ChatSandboxValue } from "./types.js";

const MAX_EVAL_TEXT_PART_CHARS = 128 * 1024;
const MAX_EVAL_PREVIEW_CHARS = 16 * 1024;
const EVAL_RETURN_SCOPE_KEY = "__lastEvalReturn";
const EVAL_CONSOLE_SCOPE_KEY = "__lastEvalConsole";

export interface BuildEvalToolOptions {
    sandbox: SandboxConfig;
    rpc: SandboxConfig["rpc"];
    runtimeTarget: "panel" | "workerRuntime";
    /** Scope manager for enter/exit eval lifecycle. If not provided, no scope management. */
    scopeManager?: ScopeManager | null;
    /** Build the ChatSandboxValue at call time (may change between calls) */
    getChatSandboxValue: () => ChatSandboxValue;
    /** Get the current scope proxy */
    getScope: () => Record<string, unknown>;
    /**
     * Override the executeSandbox function. If provided, this is used instead
     * of the default. Useful when the caller has already wrapped executeSandbox
     * with scope lifecycle hooks (like the panel's useAgenticChat).
     * When set, scopeManager is ignored (the override handles it).
     */
    executeSandbox?: (code: string, opts: SandboxOptions) => Promise<SandboxResult>;
}
/**
 * Build the eval MethodDefinition.
 *
 * Returns a tool definition with consistent formatting between panel and
 * headless contexts: console streaming via ctx.stream, structured text
 * parts for return values, scope summary, and proper error formatting.
 */
export function buildEvalTool(opts: BuildEvalToolOptions): MethodDefinition {
    const { sandbox, scopeManager } = opts;
    const runSandbox = opts.executeSandbox ?? defaultExecuteSandbox;
    return {
        description: `Execute TypeScript/JavaScript code in the sandbox.

Call \`await help()\` first when you need the live service catalog or runtime surface for this context. Only \`chat\`, \`scope\`, \`scopes\`, and \`help\` are pre-injected. Import everything else from \`@workspace/runtime\` using static \`import\`, not \`await import(...)\`.

Workspace packages (\`@workspace/*\`, \`@workspace-skills/*\`, \`@natstack/*\`) are auto-resolved — just write the \`import\` statement. npm packages require the \`imports\` parameter with \`"npm:<version>"\`.

Use \`path\` instead of \`code\` to run a context-relative TypeScript/TSX file. File-loaded eval supports static relative imports (\`./x\`, \`../x\`) from that file.

\`eval\` has no timeout parameter. Do not pass \`timeout\`; long-running work should finish, fail, or be interrupted explicitly by the user.

\`return\` sends a value back to the agent. \`console.log\` streams in real time. \`scope\` persists across eval calls.`,
        parameters: z.object({
            code: z.string().optional().describe("The TypeScript/JavaScript code to execute. Provide either code or path."),
            path: z.string().optional().describe("Context-relative TypeScript/TSX file to execute instead of inline code. Supports static relative imports."),
            syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
            imports: z.record(z.string(), z.string()).optional()
                .describe("On-demand package builds. Workspace packages (@workspace/*, @natstack/*) are auto-resolved and don't need this. Use for npm packages (\"npm:<version>\") or to pin a workspace package to a specific git ref."),
        }).strict(),
        streaming: true,
        execute: async (args: unknown, ctx: MethodExecutionContext) => {
            const typedArgs = args as {
                code?: string;
                path?: string;
                syntax?: "typescript" | "jsx" | "tsx";
                imports?: Record<string, string>;
            };
            const path = typedArgs.path?.trim();
            const code = path
                ? await loadEvalSource(opts.rpc, path)
                : typedArgs.code;
            if (!code)
                throw new Error("Missing code or path");
            // Only manage scope lifecycle if using the default executeSandbox
            // (callers who override executeSandbox handle scope themselves)
            if (!opts.executeSandbox)
                scopeManager?.enterEval();
            try {
                const result: SandboxResult = await runSandbox(code, {
                    syntax: typedArgs.syntax,
                    signal: ctx.signal,
                    imports: typedArgs.imports,
                    loadImport: sandbox.loadImport,
                    sourcePath: path,
                    loadSourceFile: path
                        ? async (filePath: string) => opts.rpc.call("main", "fs.readFile", [filePath, "utf8"]) as Promise<string>
                        : undefined,
                    bindings: {
                        chat: opts.getChatSandboxValue(),
                        scope: scopeManager?.current ?? {},
                        scopes: scopeManager?.api ?? {},
                        help: async (serviceName?: string) => {
                            if (serviceName) {
                                return await opts.rpc.call("main", "meta.describeService", [serviceName]);
                            }
                            const [services, runtime, skillPackages] = await Promise.all([
                                opts.rpc.call("main", "meta.listServices", []),
                                opts.rpc.call("main", "meta.getRuntimeSurface", [opts.runtimeTarget]),
                                opts.rpc.call("main", "build.listSkills", []).catch(() => null),
                            ]);
                            return {
                                preInjected: ["chat", "scope", "scopes", "help"],
                                runtimeUsage: 'Runtime exports are not globals. Import them with static syntax, e.g. `import { contextId, fs, rpc } from "@workspace/runtime";`.',
                                services,
                                runtime,
                                imports: {
                                    description: "Use the eval tool's `imports` parameter to load additional packages on-demand.",
                                    usage: 'Workspace packages (@workspace/*, @natstack/*) are auto-resolved. For npm: imports: { "lodash": "npm:4" }. To pin a git ref: imports: { "pkg": "branch-name" }',
                                    workspaceSkills: skillPackages ?? "Use build.listSkills to discover available skills",
                                    npmPackages: 'Use "npm:<version>" for npm packages, e.g. "npm:latest" or "npm:^4.0.0"',
                                },
                            };
                        },
                    },
                    onConsole: (formatted: string) => {
                        void ctx.stream({ type: "console", content: formatted }).catch((error) => {
                            console.error("[buildEvalTool] Failed to stream console output:", error);
                        });
                    },
                });
                const scope = opts.getScope();
                const scopeKeys = Object.keys(scope);
                const scopeLine = scopeKeys.length > 0
                    ? `[scope] keys: ${scopeKeys.join(", ")} (${scopeKeys.length} total)`
                    : "[scope] (empty)";
                if (!result.success) {
                    throw new Error(`${withSandboxErrorHint(result.error || "Eval failed")}\n${scopeLine}`);
                }
                // Format as structured text parts so the AI sees clean, readable text
                const parts: Array<{
                    type: "text";
                    text: string;
                }> = [];
                if (result.consoleOutput) {
                    const formattedConsole = boundEvalText("Console", result.consoleOutput, {
                        onOversize: () => {
                            scope[EVAL_CONSOLE_SCOPE_KEY] = result.consoleOutput;
                        },
                        scopeKey: EVAL_CONSOLE_SCOPE_KEY,
                    });
                    parts.push({ type: "text", text: `[eval] Console:\n${formattedConsole}` });
                }
                if (result.returnValue !== undefined && result.returnValue !== null) {
                    const formatted = formatEvalReturnValue(result.returnValue, {
                        onOversize: () => {
                            scope[EVAL_RETURN_SCOPE_KEY] = result.returnValue;
                        },
                        scopeKey: EVAL_RETURN_SCOPE_KEY,
                    });
                    parts.push({ type: "text", text: `[eval] Return value:\n${formatted}` });
                }
                if (result.panelJournalFooter) {
                    parts.push({ type: "text", text: result.panelJournalFooter });
                }
                if (parts.length === 0) {
                    parts.push({ type: "text", text: "[eval] (no output)" });
                }
                parts.push({ type: "text", text: scopeLine });
                return { content: parts };
            }
            finally {
                if (!opts.executeSandbox)
                    await scopeManager?.exitEval();
            }
        },
    };
}

async function loadEvalSource(
    rpc: SandboxConfig["rpc"],
    path: string
): Promise<string> {
    try {
        return await rpc.call("main", "fs.readFile", [path, "utf8"]) as string;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to load eval source from path "${path}". ` +
            `Eval path is resolved inside the current context filesystem, not the host filesystem. ` +
            `If you created a helper file, create it through this same chat/context filesystem and pass that context path. ` +
            `Underlying error: ${message}`
        );
    }
}

function formatEvalReturnValue(
    value: unknown,
    opts: { onOversize: () => void; scopeKey: string }
): string {
    let formatted: string;
    try {
        formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
    catch {
        formatted = String(value);
    }
    return boundEvalText("Return value", formatted, opts, value);
}

function boundEvalText(
    label: string,
    text: string,
    opts: { onOversize: () => void; scopeKey: string },
    valueForSummary?: unknown
): string {
    if (text.length <= MAX_EVAL_TEXT_PART_CHARS)
        return text;
    opts.onOversize();
    const previewChars = Math.min(MAX_EVAL_PREVIEW_CHARS, MAX_EVAL_TEXT_PART_CHARS);
    return [
        `[${label} omitted from tool transcript: ${text.length} characters exceeds ${MAX_EVAL_TEXT_PART_CHARS}.]`,
        `Full value stored at scope.${opts.scopeKey}. Return or inspect slices explicitly, e.g. scope.${opts.scopeKey}.`,
        summarizeLargeValue(valueForSummary),
        "",
        "[preview]",
        text.slice(0, previewChars),
    ].filter(Boolean).join("\n");
}

function summarizeLargeValue(value: unknown): string {
    const nestedDiagnostics = value && typeof value === "object"
        ? (value as Record<string, unknown>)["diagnostics"]
        : undefined;
    if (Array.isArray(nestedDiagnostics)) {
        return summarizeDiagnosticArray(nestedDiagnostics) ?? summarizeArray(nestedDiagnostics);
    }
    if (Array.isArray(value)) {
        return summarizeDiagnosticArray(value) ?? summarizeArray(value);
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `Summary: object with ${keys.length} key(s): ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", ..." : ""}.`;
    }
    return "";
}

function summarizeArray(value: unknown[]): string {
    const lines = [`Summary: array length ${value.length}.`];
    const objectKeys = mostCommon(
        value.flatMap((item) => item && typeof item === "object" ? Object.keys(item as Record<string, unknown>) : []),
        10,
    );
    if (objectKeys.length > 0) {
        lines.push(`Common keys: ${objectKeys.map(({ key, count }) => `${key} (${count})`).join(", ")}.`);
    }
    const examples = value.slice(0, 3).map((item) => compactJson(item, 300));
    if (examples.length > 0) {
        lines.push("Examples:");
        lines.push(...examples.map((example, index) => `${index + 1}. ${example}`));
    }
    return lines.join("\n");
}

function summarizeDiagnosticArray(value: unknown[]): string | null {
    const diagnostics = value
        .filter((item): item is Record<string, unknown> => isDiagnosticLike(item));
    if (diagnostics.length === 0) return null;

    const lines = [
        `Summary: diagnostics array length ${value.length}; ${diagnostics.length} diagnostic-like item(s).`,
    ];
    lines.push(`By severity: ${formatCounts(mostCommon(diagnostics.map((d) => stringField(d, "severity") ?? "unknown"), 8))}.`);

    const codes = mostCommon(
        diagnostics
            .map((d) => stringField(d, "code"))
            .filter((code): code is string => Boolean(code)),
        8,
    );
    if (codes.length > 0) lines.push(`Top codes: ${formatCounts(codes)}.`);

    const files = mostCommon(
        diagnostics
            .map((d) => stringField(d, "file"))
            .filter((file): file is string => Boolean(file)),
        8,
    );
    if (files.length > 0) lines.push(`Top files: ${formatCounts(files)}.`);

    const modules = mostCommon(
        diagnostics
            .map((d) => extractMissingModule(stringField(d, "message") ?? ""))
            .filter((moduleName): moduleName is string => Boolean(moduleName)),
        8,
    );
    if (modules.length > 0) lines.push(`Missing modules: ${formatCounts(modules)}.`);

    lines.push("Examples:");
    lines.push(...diagnostics.slice(0, 5).map((diagnostic, index) => {
        const severity = stringField(diagnostic, "severity") ?? "diagnostic";
        const code = stringField(diagnostic, "code");
        const file = stringField(diagnostic, "file");
        const line = stringField(diagnostic, "line");
        const column = stringField(diagnostic, "column");
        const location = file ? `${file}${line ? `:${line}${column ? `:${column}` : ""}` : ""}` : "(no file)";
        const message = truncateSingleLine(stringField(diagnostic, "message") ?? compactJson(diagnostic, 180), 220);
        return `${index + 1}. ${severity}${code ? ` TS${code}` : ""} ${location}: ${message}`;
    }));
    return lines.join("\n");
}

function isDiagnosticLike(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record["message"] === "string" && (
        "severity" in record ||
        "code" in record ||
        "file" in record ||
        "line" in record
    );
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    return String(value);
}

function extractMissingModule(message: string): string | null {
    return message.match(/Cannot find module ['"]([^'"]+)['"]/)?.[1] ?? null;
}

function mostCommon(values: string[], limit: number): Array<{ key: string; count: number }> {
    const counts = new Map<string, number>();
    for (const value of values) {
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }));
}

function formatCounts(counts: Array<{ key: string; count: number }>): string {
    return counts.map(({ key, count }) => `${key}=${count}`).join(", ");
}

function compactJson(value: unknown, maxChars: number): string {
    let text: string;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    }
    catch {
        text = String(value);
    }
    return truncateSingleLine(text, maxChars);
}

function truncateSingleLine(value: string, maxChars: number): string {
    const oneLine = value.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function withSandboxErrorHint(error: string): string {
    const missingRuntimeBinding = error.match(/^([A-Za-z_$][\w$]*) is not defined\b/);
    if (!missingRuntimeBinding)
        return error;
    const name = missingRuntimeBinding[1];
    if (!name)
        return error;
    const runtimeExports = new Set([
        "contextId",
        "fs",
        "db",
        "rpc",
        "ai",
        "workers",
        "workspace",
        "credentials",
        "git",
        "gad",
        "parent",
        "getParent",
        "focusPanel",
    ]);
    if (!runtimeExports.has(name))
        return error;
    return `${error}\nHint: \`${name}\` is not pre-injected in eval. Add a static import: \`import { ${name} } from "@workspace/runtime";\``;
}

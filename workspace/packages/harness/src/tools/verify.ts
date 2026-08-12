/** First-class, context-exact build and test verification for coding agents. */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { UnitBuildReportWire } from "@vibestudio/service-schemas/build";

const buildVerificationSchema = Type.Object(
  {
    operation: Type.Literal("build"),
    target: Type.String({
      minLength: 1,
      description: "Workspace unit name or path, for example packages/parser or panels/editor.",
    }),
  },
  { additionalProperties: false }
);

const testVerificationSchema = Type.Object(
  {
    operation: Type.Literal("test"),
    target: Type.String({
      minLength: 1,
      description: "Workspace unit path containing the tests.",
    }),
    file: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional test file path relative to target.",
      })
    ),
    testName: Type.Optional(
      Type.String({ minLength: 1, description: "Optional Vitest test-name pattern." })
    ),
  },
  { additionalProperties: false }
);

export const verifySchema = Type.Union([buildVerificationSchema, testVerificationSchema]);
export type VerifyToolInput =
  | { operation: "build"; target: string }
  | { operation: "test"; target: string; file?: string; testName?: string };

interface TestRunResult {
  summary: string;
  passed: number;
  failed: number;
  total: number;
  contextId: string;
  target: string;
  pattern: string;
  details: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

export type VerifyToolDetails =
  | {
      operation: "build" | "test";
      target: string;
      status: "running";
    }
  | {
      operation: "build";
      target: string;
      status: UnitBuildReportWire["status"];
      report: UnitBuildReportWire;
      truncatedDiagnostics: number;
      truncatedDiagnosticText: number;
    }
  | {
      operation: "test";
      target: string;
      status: "passed" | "failed" | "no-tests";
      report: TestRunResult;
      truncatedFiles: number;
      truncatedErrors: number;
    };

const MAX_DIAGNOSTICS = 40;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_000;
const MAX_DIAGNOSTIC_CONTEXT_CHARS = 1_000;
const MAX_TEST_FILES = 100;
const MAX_ERRORS_PER_FILE = 20;
const MAX_ERROR_CHARS = 4_000;

export function createVerifyTool(
  callMain: <T>(method: string, args: unknown[], signal?: AbortSignal) => Promise<T>,
  contextId: () => string
): AgentTool<typeof verifySchema, VerifyToolDetails> {
  return {
    name: "verify",
    label: "verify",
    description:
      'Build or test one workspace unit against this conversation\'s exact semantic working state. Use { operation:"build", target } for compiler/bundler diagnostics and { operation:"test", target, file?, testName? } for Vitest. This is the supported code-verification boundary: it materializes the exact context, preserves execution authority and approvals, returns structured bounded evidence, and never treats zero discovered tests as success. Do not emulate it with a shell command or generic eval wrapper.',
    parameters: verifySchema,
    execute: async (
      _toolCallId,
      input,
      signal,
      onUpdate
    ): Promise<AgentToolResult<VerifyToolDetails>> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
      const command = input as VerifyToolInput;
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${command.operation === "build" ? "Building" : "Testing"} ${command.target}…`,
          },
        ],
        details: { operation: command.operation, target: command.target, status: "running" },
      });
      if (command.operation === "build") {
        const report = await callMain<UnitBuildReportWire>(
          "build.getBuildReport",
          [command.target, `ctx:${contextId()}`],
          signal
        );
        const bounded = boundBuildReport(report);
        const failed = report.status !== "ok";
        return {
          content: [{ type: "text", text: renderBuild(command.target, bounded.report) }],
          details: {
            operation: "build",
            target: command.target,
            status: report.status,
            report: bounded.report,
            truncatedDiagnostics: bounded.truncatedDiagnostics,
            truncatedDiagnosticText: bounded.truncatedDiagnosticText,
          },
          isError: failed,
        };
      }

      const report = await callMain<TestRunResult>(
        "extensions.invoke",
        [
          "@workspace-extensions/test-runner",
          "run",
          [
            {
              target: command.target,
              contextId: contextId(),
              ...(command.file ? { fileFilter: command.file } : {}),
              ...(command.testName ? { testName: command.testName } : {}),
            },
          ],
        ],
        signal
      );
      const bounded = boundTestReport(report);
      const status = report.total === 0 ? "no-tests" : report.failed > 0 ? "failed" : "passed";
      return {
        content: [{ type: "text", text: renderTests(command.target, bounded.report, status) }],
        details: {
          operation: "test",
          target: command.target,
          status,
          report: bounded.report,
          truncatedFiles: bounded.truncatedFiles,
          truncatedErrors: bounded.truncatedErrors,
        },
        isError: status !== "passed",
      };
    },
  };
}

function boundBuildReport(report: UnitBuildReportWire): {
  report: UnitBuildReportWire;
  truncatedDiagnostics: number;
  truncatedDiagnosticText: number;
} {
  let truncatedDiagnosticText = 0;
  const clamp = (value: string | undefined, limit: number): string | undefined => {
    if (value === undefined || value.length <= limit) return value;
    truncatedDiagnosticText += value.length - limit;
    return `${value.slice(0, limit)}… [truncated]`;
  };
  const diagnostics = report.diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) => ({
    ...diagnostic,
    message: clamp(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARS)!,
    ...(diagnostic.lineText === undefined
      ? {}
      : { lineText: clamp(diagnostic.lineText, MAX_DIAGNOSTIC_CONTEXT_CHARS) }),
    ...(diagnostic.suggestion === undefined
      ? {}
      : { suggestion: clamp(diagnostic.suggestion, MAX_DIAGNOSTIC_CONTEXT_CHARS) }),
  }));
  const builds = report.builds.map((build) => ({
    ...build,
    diagnosticIndexes: build.diagnosticIndexes.filter((index) => index < diagnostics.length),
  }));
  return {
    report: { ...report, diagnostics, builds },
    truncatedDiagnostics: Math.max(0, report.diagnostics.length - MAX_DIAGNOSTICS),
    truncatedDiagnosticText,
  };
}

function boundTestReport(report: TestRunResult): {
  report: TestRunResult;
  truncatedFiles: number;
  truncatedErrors: number;
} {
  let truncatedErrors = 0;
  const details = report.details.slice(0, MAX_TEST_FILES).map((file) => {
    const errors = file.errors ?? [];
    truncatedErrors += Math.max(0, errors.length - MAX_ERRORS_PER_FILE);
    return {
      ...file,
      ...(file.errors
        ? {
            errors: errors
              .slice(0, MAX_ERRORS_PER_FILE)
              .map((error) =>
                error.length <= MAX_ERROR_CHARS
                  ? error
                  : `${error.slice(0, MAX_ERROR_CHARS)}… [truncated]`
              ),
          }
        : {}),
    };
  });
  return {
    report: { ...report, details },
    truncatedFiles: Math.max(0, report.details.length - MAX_TEST_FILES),
    truncatedErrors,
  };
}

function renderBuild(target: string, report: UnitBuildReportWire): string {
  return (
    `Build ${report.status} for ${target} (${report.kind}; ` +
    `${report.builds.length} target${report.builds.length === 1 ? "" : "s"}; ` +
    `${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"}). ` +
    "Structured diagnostics are in details.report.diagnostics."
  );
}

function renderTests(
  target: string,
  report: TestRunResult,
  status: "passed" | "failed" | "no-tests"
): string {
  const errors = report.details.flatMap((file) =>
    (file.errors ?? []).map((error) => `${file.file}: ${error}`)
  );
  return [
    status === "no-tests"
      ? `No tests were discovered for ${target}; verification did not pass.`
      : `Tests ${status} for ${target}: ${report.passed} passed, ${report.failed} failed, ${report.total} total.`,
    ...errors,
  ].join("\n");
}

import { describe, expect, it } from "vitest";
import * as path from "path";
import {
  BuildGateFailedError,
  BuildDiagnosticsError,
  BuildRequestError,
  diagnosticsFromError,
  workspaceDiagnosticPath,
} from "./diagnostics.js";

describe("build diagnostics path normalization", () => {
  it("preserves caller-correctable request failures across RPC without blaming infrastructure", () => {
    const error = new BuildRequestError("no_test_files", "Declared test suite selected no files", {
      include: ["**/*.test.ts"],
    });
    expect(diagnosticsFromError(error)[0]).toMatchObject({ source: "schema", severity: "error" });
    expect(diagnosticsFromError(error)[0]).not.toHaveProperty("operationalError");
    expect(error.errorData).toMatchObject({
      code: "no_test_files",
      failureKind: "invalid-input",
      include: ["**/*.test.ts"],
      retry: { policy: "correct-input", commandIdPolicy: "not-applicable" },
      recovery: { action: "correct-request" },
    });
  });
  it("maps esbuild materialized source paths back to workspace-relative files", () => {
    const sourceRoot = path.join(path.sep, "tmp", "vibestudio-build", "abc123");
    const failure = {
      errors: [
        {
          text: "Unexpected token",
          location: {
            file: path.join(sourceRoot, "panels/hello/src/App.tsx"),
            namespace: "file",
            line: 7,
            column: 4,
            length: 1,
            lineText: "const x = ;",
          },
          notes: [],
          detail: undefined,
        },
      ],
      warnings: [],
    };

    const diagnostics = diagnosticsFromError(failure, {
      workspaceRoot: path.join(path.sep, "workspace"),
      sourceRoot,
      unitRelativePath: "panels/hello",
    });

    expect(diagnostics[0]?.file).toBe("panels/hello/src/App.tsx");
  });

  it("strips an owned esbuild namespace before mapping prepared source coordinates", () => {
    const sourceRoot = path.join(path.sep, "tmp", "vibestudio-build", "abc123");
    const namespace = "vibestudio-prepared-file";
    const failure = {
      errors: [
        {
          text: "Unexpected token",
          location: {
            file: `${namespace}:${path.join(sourceRoot, "panels/hello/src/App.tsx")}`,
            namespace,
            line: 7,
            column: 4,
            length: 1,
            lineText: "const x = ;",
          },
          notes: [],
        },
      ],
      warnings: [],
    };

    const [diagnostic] = diagnosticsFromError(failure, {
      workspaceRoot: path.join(path.sep, "workspace"),
      sourceRoot,
      unitRelativePath: "panels/hello",
    });
    expect(diagnostic?.file).toBe("panels/hello/src/App.tsx");
  });

  it("prefixes unit-relative diagnostic files with the workspace unit path", () => {
    expect(
      workspaceDiagnosticPath("src/index.ts", {
        sourceRoot: path.join(path.sep, "tmp", "vibestudio-build", "abc123"),
        unitRelativePath: "panels/hello",
      })
    ).toBe("panels/hello/src/index.ts");
  });

  it("retains compiler-relative file coordinates through the later workspace report", () => {
    const sourceRoot = "/tmp/owned-instance/workspace/state/build-sources/exact-state";
    const workingDirectory = "/tmp/owned-compiler/output";
    const sourceFile = path.join(sourceRoot, "panels/tasks/index.tsx");
    const failure = {
      errors: [
        {
          text: "Expected closing parenthesis",
          location: {
            file: path.relative(workingDirectory, sourceFile),
            namespace: "file",
            line: 14,
            column: 477,
          },
          notes: [],
        },
      ],
    };
    const compilerFailure = new BuildDiagnosticsError(
      "Compilation failed",
      diagnosticsFromError(failure, { workingDirectory })
    );
    const [diagnostic] = diagnosticsFromError(compilerFailure, {
      sourceRoot,
      workspaceRoot: "/tmp/owned-instance/workspace/source",
      unitRelativePath: "panels/tasks",
    });
    expect(diagnostic).toMatchObject({
      file: "panels/tasks/index.tsx",
      line: 14,
      column: 477,
      message: "Expected closing parenthesis",
    });
  });

  it("preserves the build-report diagnostic contract for publication refusals", () => {
    const diagnostics = [
      {
        source: "tsc" as const,
        severity: "error" as const,
        file: "packages/lib/src/index.ts",
        line: 12,
        column: 4,
        message: "Type mismatch",
      },
    ];
    const error = new BuildGateFailedError(
      diagnostics,
      ["@workspace/lib", "@workspace-panels/app"],
      "state:candidate"
    );

    expect(error.code).toBe("BuildGateFailed");
    expect(error.message).toContain("packages/lib/src/index.ts:12: Type mismatch");
    expect(error.errorData).toMatchObject({
      code: "BuildGateFailed",
      candidateState: "state:candidate",
      affectedUnits: ["@workspace/lib", "@workspace-panels/app"],
      diagnostics,
      failureClass: "source",
      failureKind: "domain",
      retry: { policy: "none", commandIdPolicy: "not-applicable" },
      recovery: { action: "repair-source" },
    });
  });

  it("distinguishes infrastructure build failures and requires reobservation", () => {
    const error = new BuildGateFailedError(
      [
        {
          source: "infrastructure",
          severity: "error",
          file: "packages/lib",
          line: 1,
          column: 1,
          message: "Typecheck worker unavailable",
        },
      ],
      ["@workspace/lib"],
      "state:candidate"
    );

    expect(error.errorData).toMatchObject({
      failureClass: "infrastructure",
      failureKind: "infrastructure",
      retry: { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" },
      recovery: { action: "reobserve" },
    });
  });

  it("summarizes the first blocking error without losing full diagnostics", () => {
    const diagnostic = {
      source: "authority" as const,
      severity: "error" as const,
      file: "clients/desktop-browser/package.json",
      line: 1,
      column: 0,
      message: "Missing declared gateway capability. " + "x".repeat(800),
    };
    const diagnostics = [
      { ...diagnostic, severity: "warning" as const, message: "An earlier warning" },
      diagnostic,
      {
        ...diagnostic,
        file: "workers/system-test-runner/package.json",
        message: "Missing dependency scope",
      },
    ];
    const error = new BuildGateFailedError(
      diagnostics,
      ["@workspace-clients/desktop-browser"],
      "state:candidate"
    );
    expect(error.message).toContain(
      "clients/desktop-browser/package.json:1: Missing declared gateway capability."
    );
    expect(error.message).not.toContain("An earlier warning");
    expect(error.message).toContain("1 more error; see the structured diagnostics.");
    expect(error.message.length).toBeLessThan(800);
    expect(error.errorData).toMatchObject({ diagnostics });
  });
});

it("keeps native IO identity and safe causes distinct from compiler diagnostics", () => {
  const cause = Object.assign(new Error("private request contents"), {
    code: "EMFILE",
    syscall: "watch",
    headers: { authorization: "secret" },
  });
  const error = new Error("Owned compiler setup failed", { cause });
  const [diagnostic] = diagnosticsFromError(error);
  expect(diagnostic).toMatchObject({
    source: "infrastructure",
    severity: "error",
    message: "Owned compiler setup failed",
    operationalError: { name: "Error", cause: { name: "Error", code: "EMFILE", syscall: "watch" } },
  });
  expect(JSON.stringify(diagnostic?.operationalError)).not.toMatch(
    /private|secret|headers|message/
  );
});
it("preserves operational plugin details without relabeling ordinary compiler errors", () => {
  const native = Object.assign(new Error("watch failed"), { code: "EMFILE", syscall: "watch" });
  const diagnostics = diagnosticsFromError({
    errors: [
      { text: "Owned plugin could not start", location: null, notes: [], detail: native },
      {
        text: "Expected expression",
        location: { file: "src/a.ts", line: 2, column: 1 },
        notes: [],
      },
    ],
  });
  expect(diagnostics[0]).toMatchObject({
    source: "infrastructure",
    operationalError: { code: "EMFILE" },
  });
  expect(diagnostics[1]).toMatchObject({
    source: "esbuild",
    message: "Expected expression",
    file: "src/a.ts",
    line: 2,
    column: 1,
  });
  expect(diagnostics[1]).not.toHaveProperty("operationalError");
});
it("does not execute unknown error getters or conversions while observing a failure", () => {
  let accesses = 0;
  const fail = () => {
    accesses++;
    throw Error("observer must not run");
  };
  const error = Object.create(null);
  for (const key of [
    "message",
    "name",
    "code",
    "cause",
    "errors",
    "warnings",
    "toJSON",
    "toString",
  ])
    Object.defineProperty(error, key, { get: fail });
  expect(diagnosticsFromError(error)[0]).toMatchObject({
    source: "infrastructure",
    message: "Build operation failed",
    operationalError: {},
  });
  expect(accesses).toBe(0);
});

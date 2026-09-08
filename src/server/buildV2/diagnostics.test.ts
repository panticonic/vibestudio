import { describe, expect, it } from "vitest";
import * as path from "path";
import {
  BuildGateFailedError,
  diagnosticsFromError,
  workspaceDiagnosticPath,
} from "./diagnostics.js";

describe("build diagnostics path normalization", () => {
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

  it("prefixes unit-relative diagnostic files with the workspace unit path", () => {
    expect(
      workspaceDiagnosticPath("src/index.ts", {
        sourceRoot: path.join(path.sep, "tmp", "vibestudio-build", "abc123"),
        unitRelativePath: "panels/hello",
      })
    ).toBe("panels/hello/src/index.ts");
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
      file: "apps/shell/package.json",
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
      ["@workspace-apps/shell"],
      "state:candidate"
    );
    expect(error.message).toContain(
      "apps/shell/package.json:1: Missing declared gateway capability."
    );
    expect(error.message).not.toContain("An earlier warning");
    expect(error.message).toContain("1 more error; see the structured diagnostics.");
    expect(error.message.length).toBeLessThan(800);
    expect(error.errorData).toMatchObject({ diagnostics });
  });
});

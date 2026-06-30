import { describe, expect, it } from "vitest";
import * as path from "path";
import { diagnosticsFromError, workspaceDiagnosticPath } from "./diagnostics.js";

describe("build diagnostics path normalization", () => {
  it("maps esbuild materialized source paths back to workspace-relative files", () => {
    const sourceRoot = path.join(path.sep, "tmp", "vibez1-build", "abc123");
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
        sourceRoot: path.join(path.sep, "tmp", "vibez1-build", "abc123"),
        unitRelativePath: "panels/hello",
      })
    ).toBe("panels/hello/src/index.ts");
  });
});

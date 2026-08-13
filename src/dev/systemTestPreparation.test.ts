import { describe, expect, it } from "vitest";
import {
  assertSystemTestPreparationResult,
  systemTestPreparationFailureDetail,
} from "./systemTestPreparation.js";

describe("managed system-test startup preparation output", () => {
  it("reports failed JSON checks from stdout ahead of incidental stderr warnings", () => {
    const output = `${JSON.stringify({
      ok: false,
      checks: [
        {
          name: "claude-code-extension",
          ok: false,
          detail: "registry status: building",
        },
      ],
    })}\n`;

    expect(systemTestPreparationFailureDetail(output, "ExperimentalWarning: SQLite")).toBe(
      "claude-code-extension: registry status: building\n" +
        "Subprocess stderr:\nExperimentalWarning: SQLite"
    );
  });

  it("requires a successful doctor receipt for the exact paired workspace", () => {
    const output = `${JSON.stringify({
      ok: true,
      checks: [
        {
          name: "server",
          ok: true,
          detail: "reachable",
          data: { workspaceId: "workspace-one" },
        },
      ],
    })}\n`;

    expect(() => assertSystemTestPreparationResult(output, "workspace-one")).not.toThrow();
    expect(() => assertSystemTestPreparationResult(output, "workspace-two")).toThrow(
      /reached workspace workspace-one; expected workspace-two/u
    );
    expect(() =>
      assertSystemTestPreparationResult('{"ok":false,"checks":[]}\n', "workspace-one")
    ).toThrow(/no successful doctor result/u);
  });
});

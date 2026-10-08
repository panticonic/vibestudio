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
          name: "external-agent-extension",
          ok: false,
          detail: "registry status: building",
        },
      ],
    })}\n`;

    expect(systemTestPreparationFailureDetail(output, "ExperimentalWarning: SQLite")).toBe(
      "external-agent-extension: registry status: building\n" +
        "Subprocess stderr:\nExperimentalWarning: SQLite"
    );
  });

  it("requires a successful doctor receipt for the exact paired workspace", () => {
    const output = `${JSON.stringify({
      ok: true,
      startupApprovals: {
        approvedReviewIds: ["creation-review"],
        approvedPartCount: 2,
        creationReviewStatus: "resolved",
      },
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

  it("requires review lifecycle completion while allowing an already-reviewed restart", () => {
    const result = (creationReviewStatus?: string) =>
      JSON.stringify({
        ok: true,
        startupApprovals: { approvedReviewIds: [], approvedPartCount: 0, creationReviewStatus },
        checks: [{ name: "server", ok: true, data: { workspaceId: "workspace-one" } }],
      });
    expect(() =>
      assertSystemTestPreparationResult(result("not-required"), "workspace-one")
    ).not.toThrow();
    expect(() =>
      assertSystemTestPreparationResult(result("resolved"), "workspace-one")
    ).not.toThrow();
    for (const status of [undefined, "preparing", "unresolved", "failed"]) {
      expect(() => assertSystemTestPreparationResult(result(status), "workspace-one")).toThrow(
        /no completed creation-review receipt/u
      );
    }
  });
});

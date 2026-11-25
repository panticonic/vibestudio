import { describe, expect, it } from "vitest";
import {
  assertSystemTestPreparationResult,
  systemTestPreparationFailureDetail,
  canUseRequestedStartupDoctor,
  startupDoctorCommand,
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
        checks: [
          { name: "server", ok: true, detail: "reachable", data: { workspaceId: "workspace-one" } },
        ],
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

  it("preserves the caller's exact doctor model/session and one approval/json flag", () => {
    const command = [
      "doctor",
      "--session",
      "owned-review",
      "--model",
      "openai-codex:gpt-6-luna",
      "--approve-startup",
      "--json",
    ];
    expect(startupDoctorCommand(command)).toEqual(command);
    expect(startupDoctorCommand(["run", "actual-case", "--model=openai-codex:gpt-6-luna"])).toEqual(
      ["doctor", "--approve-startup", "--json", "--model=openai-codex:gpt-6-luna"]
    );
    expect(
      startupDoctorCommand(["run", "actual-case", "--model", "openai-codex:gpt-6-luna"])
    ).toEqual(["doctor", "--approve-startup", "--json", "--model", "openai-codex:gpt-6-luna"]);
    expect(() => startupDoctorCommand(["run", "actual-case", "--model"])).toThrow(
      "requires a value"
    );
    expect(startupDoctorCommand(["run", "--", "--model", "literal-test-name"])).toEqual([
      "doctor",
      "--approve-startup",
      "--json",
    ]);
    expect(startupDoctorCommand(["run", "native-case", "--native-reference"])).toEqual([
      "doctor",
      "--approve-startup",
      "--json",
      "--native-reference",
    ]);
  });

  it("reuses a fresh doctor's validated result while retaining distinct adoption/device and explicit recheck phases", () => {
    const fresh = {
      created: true,
      command: ["doctor"],
      selfDevelopment: false,
      devices: [],
      recheck: false,
    };
    expect(canUseRequestedStartupDoctor(fresh)).toBe(true);
    for (const changed of [
      { created: false },
      { command: ["run", "case"] },
      { selfDevelopment: true },
      { devices: ["terminal"] },
      { recheck: true },
    ]) {
      expect(canUseRequestedStartupDoctor({ ...fresh, ...changed })).toBe(false);
    }
  });

  it("rejects a contradictory successful aggregate and retains original startup metadata", () => {
    const result = {
      ok: true,
      checks: [
        { name: "server", ok: true, detail: "reachable", data: { workspaceId: "workspace-one" } },
      ],
      startupApprovals: { creationReviewStatus: "resolved", approvedPartCount: 2 },
      extraNativeObservation: { id: "actual" },
    };
    expect(assertSystemTestPreparationResult(JSON.stringify(result), "workspace-one")).toEqual(
      result
    );
    expect(() =>
      assertSystemTestPreparationResult(
        JSON.stringify({ ...result, checks: [{ ...result.checks[0], ok: false }] }),
        "workspace-one"
      )
    ).toThrow("failed readiness checks");
  });
});

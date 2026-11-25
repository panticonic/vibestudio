import { expect, it, vi } from "vitest";
import { printSystemTestDoctorResult } from "./systemTestDoctorOutput.js";

it("preserves the full actual receipt in JSON and the canonical human check view", () => {
  const result = {
    ok: true,
    checks: [
      { name: "server", ok: true, detail: "current workspace", data: { workspaceId: "owned" } },
    ],
    startupApprovals: { creationReviewStatus: "resolved" },
  };
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    printSystemTestDoctorResult(result, true);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(result);
    output.mockClear();
    printSystemTestDoctorResult(result, false);
    expect(output).toHaveBeenCalledWith("PASS\tserver\tcurrent workspace");
  } finally {
    output.mockRestore();
  }
});

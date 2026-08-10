import { describe, expect, it, vi } from "vitest";
import { composeOptionalTemplateSnapshot, optionalTemplateCatalog } from "./templates.js";

describe("optional onboarding templates", () => {
  it("projects installed and available state from one Composer status read", async () => {
    const status = vi.fn(
      async () =>
        [
          {
            url: optionalTemplateCatalog[1]!.url,
          },
        ] as never
    );

    const snapshot = await composeOptionalTemplateSnapshot({
      status,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    expect(status).toHaveBeenCalledOnce();
    expect(snapshot).toEqual([
      expect.objectContaining({ id: "template.examples", state: "available" }),
      expect.objectContaining({ id: "template.news", state: "installed" }),
      expect.objectContaining({ id: "template.spectrolite", state: "available" }),
    ]);
    expect(new Set(snapshot.map((entry) => entry.observedAt))).toEqual(
      new Set(["2026-08-10T12:00:00.000Z"])
    );
  });

  it("fails closed when Composer status is unavailable", async () => {
    const snapshot = await composeOptionalTemplateSnapshot({
      status: vi.fn(async () => {
        throw new Error("private diagnostic");
      }),
    });

    expect(snapshot.every((entry) => entry.state === "unknown")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private diagnostic");
  });
});

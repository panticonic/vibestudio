import { describe, expect, it, vi } from "vitest";
import { createTemplatesClient, TEMPLATES_EXTENSION } from "./templatesClient.js";

describe("templates client", () => {
  it("invokes the retained userland extension", async () => {
    const call = vi.fn().mockResolvedValue({
      pin: {
        url: "https://example.test/template.git",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}`,
      },
      repositories: [],
      files: [],
    });
    const locator = { url: "https://example.test/template.git" };
    await createTemplatesClient({ call }).inspect(locator);
    expect(call).toHaveBeenCalledWith("extensions.invoke", [
      TEMPLATES_EXTENSION,
      "inspect",
      [locator],
    ]);
  });
});

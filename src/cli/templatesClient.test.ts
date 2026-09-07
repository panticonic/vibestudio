import { describe, expect, it, vi } from "vitest";
import { createTemplatesClient, TEMPLATES_EXTENSION } from "./templatesClient.js";

describe("templates client", () => {
  it("invokes the retained userland extension", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTemplatesClient({ call }).catalog();
    expect(call).toHaveBeenCalledWith("extensions.invoke", [TEMPLATES_EXTENSION, "catalog", []]);
  });
});

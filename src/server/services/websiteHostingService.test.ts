import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createWebsiteHostingService } from "./websiteHostingService.js";
import type { WebsiteDocuments } from "./websiteDocuments.js";

function fixture() {
  const list = vi.fn(() => []);
  const service = createWebsiteHostingService({ list } as unknown as WebsiteDocuments, () => null, {
    hasAppCapability: (id, capability) => id === "app:chrome" && capability === "panel-hosting",
  });
  return { list, service };
}

function context(id: string, kind: "shell" | "app" | "panel", userId = "alice") {
  return {
    caller: createVerifiedCaller(id, kind, null, null, { userId, handle: userId }),
  } as ServiceContext;
}

describe("website connection inventory", () => {
  it("reads only the authenticated chrome viewer's inventory", async () => {
    const f = fixture();
    await f.service.handler(context("shell:desktop", "shell"), "list", []);
    expect(f.list).toHaveBeenLastCalledWith("alice");
    await f.service.handler(context("app:chrome", "app", "bob"), "list", []);
    expect(f.list).toHaveBeenLastCalledWith("bob");
  });

  it("rejects ordinary panels and apps before reading document metadata", async () => {
    const f = fixture();
    for (const ctx of [context("panel:website", "panel"), context("app:ordinary", "app")]) {
      await expect(f.service.handler(ctx, "list", [])).rejects.toThrow(
        /authenticated workspace chrome/
      );
    }
    expect(f.list).not.toHaveBeenCalled();
  });
});

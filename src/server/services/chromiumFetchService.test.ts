import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { createChromiumFetchService } from "./chromiumFetchService.js";

function panelCtx(): ServiceContext {
  return {
    caller: createVerifiedCaller("panel:panels/chat:1", "panel", {
      callerId: "panel:panels/chat:1",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-test",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "credential.use",
          resource: { kind: "prefix", prefix: "https://" },
        },
      ],
    }),
  };
}

describe("chromiumFetchService", () => {
  it("presents browser fetches as normal authenticated page loads", () => {
    const service = createChromiumFetchService({
      open: vi.fn(),
      read: vi.fn(),
      close: vi.fn(),
    });
    const prepare = service.authorityPreparation?.["chromiumFetch.openBrowser.origin"];

    expect(prepare?.(panelCtx(), ["https://example.com/account?tab=billing"])).toEqual({
      selections: [
        expect.objectContaining({
          capability: "credential.use",
          resourceKey: "https://example.com",
          challenge: expect.objectContaining({
            title: "Use your browser session",
            description: expect.stringContaining("normal browser page"),
            resource: expect.objectContaining({ value: "https://example.com" }),
            operation: expect.objectContaining({
              verb: "load a website using your signed-in browser session",
            }),
          }),
        }),
      ],
      payload: null,
    });
  });
});

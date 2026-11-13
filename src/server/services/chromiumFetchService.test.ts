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

const RESPONSE_IDS = ["7c9e6679-7425-40de-944b-e07fc1f90ae7"];
const RESPONSE_ID = RESPONSE_IDS[0]!;

function fixture() {
  const hostListeners = new Set<(hostConnectionId: string) => void>();
  const entityListeners = new Set<(entityId: string) => void>();
  let opened = 0;
  const deps = {
    open: vi.fn(async (url: string) => ({
      hostConnectionId: "host-1",
      response: {
        responseId: RESPONSE_IDS[opened++]!,
        url,
        status: 200,
        statusText: "OK",
        headers: {},
        size: 3,
      },
    })),
    read: vi.fn(async () => ({ bytesBase64: "YWJj", done: true })),
    close: vi.fn(async () => undefined),
    onHostDisconnected: (listener: (hostConnectionId: string) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
    onEntityRetired: (listener: (entityId: string) => void) => {
      entityListeners.add(listener);
      return () => entityListeners.delete(listener);
    },
    reportCloseFailure: vi.fn(),
  };
  return {
    deps,
    disconnectHost: (id: string) => hostListeners.forEach((listener) => listener(id)),
    retireEntity: (id: string) => entityListeners.forEach((listener) => listener(id)),
  };
}

const handle = (
  service: ReturnType<typeof createChromiumFetchService>,
  method: string,
  args: unknown[]
) => service.handler(panelCtx(), method, args);

describe("chromiumFetchService", () => {
  it("returns the final bytes when releasing the host's copy fails", async () => {
    const f = fixture();
    const failure = new Error("host gone");
    f.deps.close.mockRejectedValueOnce(failure);
    const service = createChromiumFetchService(f.deps);
    await handle(service, "openPublic", ["https://example.com/"]);

    await expect(handle(service, "read", [RESPONSE_ID, 0, 1024])).resolves.toEqual({
      bytesBase64: "YWJj",
      done: true,
    });
    await vi.waitFor(() =>
      expect(f.deps.reportCloseFailure).toHaveBeenCalledWith(RESPONSE_ID, failure)
    );
  });

  it("closes an owner's open responses when its runtime entity retires", async () => {
    const f = fixture();
    const service = createChromiumFetchService(f.deps);
    await handle(service, "openPublic", ["https://example.com/"]);

    f.retireEntity("panel:panels/chat:1");
    expect(f.deps.close).toHaveBeenCalledWith("host-1", RESPONSE_ID);
    await expect(handle(service, "read", [RESPONSE_ID, 0, 1024])).rejects.toThrow(
      "Chromium response is unavailable"
    );
  });

  it("forgets a disconnected host's responses", async () => {
    const f = fixture();
    const service = createChromiumFetchService(f.deps);
    await handle(service, "openPublic", ["https://example.com/"]);

    f.disconnectHost("host-1");
    expect(f.deps.close).not.toHaveBeenCalled();
    await expect(handle(service, "read", [RESPONSE_ID, 0, 1024])).rejects.toThrow(
      "Chromium response is unavailable"
    );
    service.stop();
  });

  it("presents browser fetches as normal authenticated page loads", () => {
    const service = createChromiumFetchService(fixture().deps);
    const prepare = service.authorityPreparation?.["chromiumFetch.openBrowser.origin"];

    expect(prepare?.(panelCtx(), ["https://example.com/account?tab=billing"])).toEqual({
      selections: [
        expect.objectContaining({
          capability: "credential.use",
          resourceKey: "https://example.com",
          challenge: expect.objectContaining({
            title: "Use your signed-in browser",
            description: expect.stringContaining("normal browser page"),
            resource: expect.objectContaining({ value: "https://example.com" }),
            operation: expect.objectContaining({
              verb: "load a website using your signed-in browser",
            }),
          }),
        }),
      ],
      payload: null,
    });
  });
});

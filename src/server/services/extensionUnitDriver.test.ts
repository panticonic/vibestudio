import { describe, expect, it, vi } from "vitest";
import type { ExtensionHost } from "@vibestudio/extension-host";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createExtensionUnitDriver } from "./extensionUnitDriver.js";

describe("extension activation", () => {
  it("reads extension health from one retained diagnostic snapshot", async () => {
    const row = {
      name: "@workspace-extensions/status",
      source: "extensions/status",
      status: "running",
      activeBundleKey: "build-status",
      lastError: null,
      inspectorUrl: null,
    };
    const history = vi.fn(() => ({
      entries: [
        {
          entityId: row.name,
          kind: "extension" as const,
          timestamp: 1,
          level: "info" as const,
          message: "ready",
          source: "ctx.log" as const,
        },
      ],
      errors: [
        {
          entityId: row.name,
          kind: "extension" as const,
          timestamp: 2,
          level: "error" as const,
          message: "startup failed",
          source: "stderr" as const,
        },
      ],
      dropped: { entries: 4, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const host = {
      listWorkspaceUnits: () => [row],
      listWorkspaceUnitLogs: vi.fn(() => []),
      ensureActivated: vi.fn(),
    };
    const driver = createExtensionUnitDriver(
      () => host as unknown as ExtensionHost,
      async () => {},
      {
        history,
      }
    );

    expect(driver.health(row.name)).toMatchObject({
      logs: [{ message: "ready", source: "structured" }],
      errors: [{ message: "startup failed", source: "stderr" }],
      dropped: { entries: 4, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    });
    expect(history).toHaveBeenCalledExactlyOnceWith(row.name, undefined);
    expect(host.listWorkspaceUnitLogs).not.toHaveBeenCalled();
  });

  it.each(["available", "running", "pending-approval", "building"])(
    "stages a declaration and waits for its activation owner from %s",
    async (status) => {
      const row = {
        name: "@workspace-extensions/react-native",
        source: "extensions/react-native",
        status,
        activeBundleKey: null,
        lastError: null,
        inspectorUrl: null,
      };
      const rows: (typeof row)[] = [];
      let markOwnerStarted!: () => void;
      const ownerStarted = new Promise<void>((resolve) => {
        markOwnerStarted = resolve;
      });
      let finishActivation!: () => void;
      const activationReady = new Promise<void>((resolve) => {
        finishActivation = resolve;
      });
      const host = {
        listWorkspaceUnits: () => rows,
        ensureActivated: vi.fn(async (releaseId: string) => {
          markOwnerStarted();
          await activationReady;
          expect(releaseId).toBe(row.name);
          row.status = "running";
        }),
        activate: vi.fn(),
      };
      const ensureDeclaration = vi.fn(async () => {
        rows.push(row);
      });
      const driver = createExtensionUnitDriver(
        () => host as unknown as ExtensionHost,
        ensureDeclaration,
        {
          history: () => ({
            entries: [],
            errors: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 1000, errors: 500 },
          }),
        }
      );
      let completed = false;
      const activation = Promise.resolve(
        driver.activation!.activate({} as ServiceContext, row.name)
      );
      void activation.then(() => {
        completed = true;
      });
      await ownerStarted;
      expect(completed).toBe(false);
      expect(ensureDeclaration).toHaveBeenCalledWith(row.name);
      expect(host.ensureActivated).toHaveBeenCalledExactlyOnceWith(row.name);
      finishActivation();
      const result = await activation;
      expect(result).toMatchObject({
        status: "ready",
        entity: { identity: { kind: "extension", entityId: row.name }, status: "running" },
      });
      expect(host.activate).not.toHaveBeenCalled();
    }
  );

  it("propagates the activation owner's original failure", async () => {
    const row = {
      name: "@workspace-extensions/react-native",
      source: "extensions/react-native",
      status: "available",
      activeBundleKey: null,
      lastError: null,
      inspectorUrl: null,
    };
    const rows = [row];
    const failure = new Error("extension build failed");
    const host = {
      listWorkspaceUnits: () => rows,
      ensureActivated: vi.fn(async () => {
        throw failure;
      }),
      activate: vi.fn(),
    };
    const ensureDeclaration = vi.fn(async () => {});
    const driver = createExtensionUnitDriver(
      () => host as unknown as ExtensionHost,
      ensureDeclaration,
      {
        history: () => ({
          entries: [],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        }),
      }
    );

    await expect(driver.activation!.activate({} as ServiceContext, row.name)).rejects.toBe(failure);
    expect(ensureDeclaration).toHaveBeenCalledWith(row.name);
    expect(host.ensureActivated).toHaveBeenCalledExactlyOnceWith(row.name);
  });
});

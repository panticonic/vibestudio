import { describe, expect, it, vi } from "vitest";
import type { ExtensionHost } from "@vibestudio/extension-host";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createExtensionUnitDriver } from "./extensionUnitDriver.js";

describe("extension activation", () => {
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
        ensureDeclaration
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
      ensureDeclaration
    );

    await expect(driver.activation!.activate({} as ServiceContext, row.name)).rejects.toBe(failure);
    expect(ensureDeclaration).toHaveBeenCalledWith(row.name);
    expect(host.ensureActivated).toHaveBeenCalledExactlyOnceWith(row.name);
  });
});

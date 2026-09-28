import { describe, expect, it, vi } from "vitest";
import type { ExtensionHost } from "@vibestudio/extension-host";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createExtensionUnitDriver } from "./extensionUnitDriver.js";

describe("extension activation", () => {
  it.each(["available", "running", "pending-approval", "building"])(
    "stages a dormant declaration before reading its %s state",
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
      const host = {
        listWorkspaceUnits: () => rows,
        ensureActivated: vi.fn(async () => {
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
      const result = await driver.activation!.activate({} as ServiceContext, row.name);
      expect(ensureDeclaration).toHaveBeenCalledWith(row.name);
      expect(result.status).toBe(
        status === "available" || status === "running"
          ? "ready"
          : status === "building"
            ? "preparing"
            : "approval-required"
      );
      expect(host.ensureActivated).toHaveBeenCalledTimes(
        status === "available" || status === "running" ? 1 : 0
      );
      expect(host.activate).not.toHaveBeenCalled();
    }
  );
});

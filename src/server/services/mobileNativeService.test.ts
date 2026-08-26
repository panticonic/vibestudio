import { describe, expect, it } from "vitest";
import { mobileNativeMethods } from "@vibestudio/service-schemas/mobileNative";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  androidInstallPlan,
  createMobileNativeService,
  workspaceReadinessFromLog,
} from "./mobileNativeService.js";

describe("mobileNative service", () => {
  it("owns the complete typed facade without exposing appRoot", () => {
    const service = createMobileNativeService({ appRoot: "/installed/vibestudio" });
    expect(service.name).toBe("mobileNative");
    expect(service.methods).toBe(mobileNativeMethods);
    expect(service.authority).toEqual({ principals: ["host", "code"] });
    expect(JSON.stringify(service)).not.toContain("/installed/vibestudio");
  });

  it("requires native.mobile.execute for device data and mutations", () => {
    for (const method of Object.values(mobileNativeMethods)) {
      expect(method.authority).toMatchObject({
        resource: { kind: "literal", key: "native.mobile" },
      });
      expect(method.capability).toBe("native.mobile.execute");
      expect(method.tier.tier).toBe("gated");
    }
  });

  it("keeps mobile debugging on the internal build from a complete source checkout", () => {
    expect(() => androidInstallPlan("/installed/vibestudio", { device: "phone-1" })).toThrow(
      /complete Vibestudio source checkout/
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-mobile-plan-"));
    try {
      for (const relative of [
        "apps/mobile/android/gradlew",
        "apps/mobile/package.json",
        "apps/mobile/index.js",
        "node_modules/react-native/package.json",
      ]) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "");
      }
      const source = androidInstallPlan(root);
      expect(source).toMatchObject({
        packageName: "app.vibestudio.mobile.internal",
      });
      expect(source.args).toContain("--from-source");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes stable workspace readiness and failure markers", () => {
    expect(
      workspaceReadinessFromLog(
        "1 phase=workspace-connected\n2 phase=workspace-panels-initialized\n3 phase=workspace-panel-webview-loaded"
      )
    ).toMatchObject({ ready: true, workspaceConnected: true, panelHostReady: true });
    expect(
      workspaceReadinessFromLog(
        "1 phase=workspace-connected\n2 phase=workspace-panels-initialized\n3 phase=workspace-panel-webview-error bad"
      )
    ).toMatchObject({ ready: false, issues: [expect.stringContaining("panel-webview-error")] });
  });
});

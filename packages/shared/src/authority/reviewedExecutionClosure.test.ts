import { describe, expect, it } from "vitest";
import type { MissionCharter, MissionToolExposure } from "./mission.js";
import {
  compileMissionExposure,
  compiledExposureAllowsService,
  compiledExposureAllowsUserlandService,
  compiledExposureNetworkRedirectPolicy,
} from "./reviewedExecutionClosure.js";

function charter(overrides: Partial<MissionToolExposure> = {}): MissionCharter {
  return {
    summary: "task",
    harness: { unit: "workers/agent", ev: "a".repeat(64) },
    execution: {
      kind: "agent",
      target: { source: "workers/agent", className: "Agent", objectKey: "agent" },
      prompt: "task",
      conversation: { mode: "fresh" },
      toolExposure: {
        services: ["docs.*", "runtime.describe"],
        userlandServices: [
          {
            name: "mail",
            provider: "extensions/mail",
            providerEv: "b".repeat(64),
            upgradePolicy: "pinned",
          },
        ],
        workspaceServiceDiscovery: "bound",
        evalNetwork: "declared-origins",
        declaredOrigins: ["https://api.example.test"],
        ...overrides,
      },
      declaredLineageClasses: ["none"],
    },
    trigger: { kind: "manual" },
  };
}

describe("compiled reviewed-execution exposure", () => {
  it("expands charter patterns into exact methods", () => {
    const exposure = compileMissionExposure(charter(), [
      "runtime.describe",
      "docs.read",
      "docs.write",
      "other.read",
    ]);
    expect(exposure.serviceMethods).toEqual(["docs.read", "docs.write", "runtime.describe"]);
    expect(compiledExposureAllowsService(exposure, "docs.read")).toBe(true);
    expect(compiledExposureAllowsService(exposure, "docs.future")).toBe(false);
  });

  it("enforces exact pinned bindings and network audiences", () => {
    const exposure = compileMissionExposure(charter(), []);
    expect(
      compiledExposureAllowsUserlandService(exposure, {
        name: "mail",
        provider: "extensions/mail",
        providerEv: "b".repeat(64),
      })
    ).toBe(true);
    expect(compiledExposureNetworkRedirectPolicy(exposure, "https://api.example.test")).toBe(
      "allow-without-redirects"
    );
    expect(compiledExposureNetworkRedirectPolicy(exposure, "https://other.test")).toBe("deny");
  });

  it("compiles method automation to no agent-session exposure", () => {
    const value: MissionCharter = {
      summary: "refresh cache",
      harness: { unit: "workers/cache", ev: "c".repeat(64) },
      execution: {
        kind: "method",
        target: { source: "workers/cache", className: "CacheDO", objectKey: "main" },
        method: "refresh",
        args: [],
      },
      trigger: { kind: "manual" },
    };
    expect(compileMissionExposure(value, ["docs.read"])).toEqual({
      serviceMethods: [],
      userlandServices: { discovery: "bound", bindings: [] },
      network: { mode: "none" },
    });
  });
});

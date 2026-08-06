import { describe, expect, it } from "vitest";
import type { MissionCharter } from "./mission.js";
import {
  compileMissionExposure,
  compiledExposureAllowsService,
  compiledExposureAllowsUserlandService,
  compiledExposureNetworkRedirectPolicy,
} from "./reviewedExecutionClosure.js";

function charter(overrides: Partial<MissionCharter["toolExposure"]> = {}): MissionCharter {
  return {
    agentBindingId: "agent",
    taskSpec: "task",
    harness: { unit: "workers/agent", ev: "a".repeat(64) },
    skills: [],
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
    model: { modelId: "model", params: {} },
    declaredLineageClasses: ["none"],
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
    expect(
      compiledExposureAllowsUserlandService(exposure, {
        name: "mail",
        provider: "extensions/mail",
        providerEv: "c".repeat(64),
      })
    ).toBe(false);
    expect(compiledExposureNetworkRedirectPolicy(exposure, "https://api.example.test")).toBe(
      "allow-without-redirects"
    );
    expect(compiledExposureNetworkRedirectPolicy(exposure, "https://other.test")).toBe("deny");
  });

  it("makes live discovery and unrestricted egress explicit compiled states", () => {
    const exposure = compileMissionExposure(
      charter({
        userlandServices: [],
        workspaceServiceDiscovery: "live-declarations",
        evalNetwork: "unrestricted",
        declaredOrigins: [],
      }),
      ["workers.resolveService"]
    );
    expect(compiledExposureAllowsService(exposure, "workers.resolveService")).toBe(true);
    expect(
      compiledExposureAllowsUserlandService(exposure, {
        name: "anything",
        provider: "extensions/anything",
        providerEv: "head",
      })
    ).toBe(true);
    expect(compiledExposureNetworkRedirectPolicy(exposure, "https://anywhere.test")).toBe("allow");
  });
});

import { describe, expect, it } from "vitest";
import type { MissionCharter, MissionToolExposure } from "./mission.js";
import {
  compileMissionExposure,
  compileMissionHarnessGrants,
  compiledExposureAllowsService,
  compiledExposureAllowsUserlandService,
  compiledExposureNetworkRedirectPolicy,
} from "./reviewedExecutionClosure.js";

function charter(overrides: Partial<MissionToolExposure> = {}): MissionCharter {
  return {
    summary: "task",
    harness: { unit: "workers/agent", ev: "a".repeat(64), ref: `state:${"b".repeat(64)}` },
    execution: {
      kind: "agent",
      target: { source: "workers/agent", className: "Agent", objectKey: "agent" },
      action: { kind: "prompt", text: "task" },
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
    expect(exposure.serviceMethods).toEqual([
      "blobstore.getText",
      "blobstore.putText",
      "contextIntegrity.ingest",
      "credentials.resolveCredential",
      "docs.read",
      "docs.write",
      "eval.cancel",
      "eval.get",
      "eval.start",
      "runtime.describe",
      "workspace-state.alarmClear",
      "workspace-state.alarmSet",
      "workspace-state.lifecycleLeaseClear",
      "workspace-state.lifecycleLeaseUpsert",
    ]);
    expect(exposure.harnessUserlandServices).toEqual([
      "channel",
      "gad.workspace",
      "workspace.state",
    ]);
    expect(compiledExposureAllowsService(exposure, "docs.read")).toBe(true);
    expect(compiledExposureAllowsService(exposure, "docs.future")).toBe(false);
    expect(compiledExposureAllowsService(exposure, "workers.resolveService")).toBe(true);
    expect(compileMissionHarnessGrants(charter()).map((grant) => grant.capability)).toEqual([
      "workspace-service:channel",
      "workspace-service:gad.workspace",
      "workspace-service:workspace.state",
    ]);
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
        name: "gad.workspace",
        provider: "workers/workspace-source",
        providerEv: "d".repeat(64),
      })
    ).toBe(true);
    expect(
      compiledExposureAllowsUserlandService(exposure, {
        name: "channel",
        provider: "workers/pubsub-channel",
        providerEv: "c".repeat(64),
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
      harness: { unit: "workers/cache", ev: "c".repeat(64), ref: `state:${"d".repeat(64)}` },
      execution: {
        kind: "method",
        target: { source: "workers/cache", className: "CacheDO", objectKey: "main" },
        method: "refresh",
        args: [],
      },
      trigger: { kind: "manual" },
    };
    expect(compileMissionExposure(value, ["docs.read"])).toEqual({
      serviceMethods: [
        "workspace-state.alarmClear",
        "workspace-state.alarmSet",
        "workspace-state.lifecycleLeaseClear",
        "workspace-state.lifecycleLeaseUpsert",
      ],
      harnessUserlandServices: ["workspace.state"],
      userlandServices: { discovery: "bound", bindings: [] },
      network: { mode: "none" },
    });
    expect(compileMissionHarnessGrants(value)).toEqual([
      {
        effect: "allow",
        capability: "workspace-service:workspace.state",
        resource: { kind: "prefix", prefix: "" },
        tier: "gated",
      },
    ]);
  });
});

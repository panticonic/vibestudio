import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagedService } from "@vibestudio/shared/managedService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildSystemV2 } from "../buildV2/index.js";
import {
  wireRuntimeObservability,
  type RuntimeObservabilityBootstrapDeps,
} from "./runtimeObservability.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function captureBootstrap(): {
  managed: ManagedService[];
  rpc: ServiceDefinition[];
  diagnostics: ReturnType<typeof wireRuntimeObservability>;
} {
  const managed: ManagedService[] = [];
  const rpc: ServiceDefinition[] = [];
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-observability-"));
  tempDirs.push(statePath);
  const container: RuntimeObservabilityBootstrapDeps["container"] = {
    registerManaged: (service) => managed.push(service),
    registerRpc: (definition) => rpc.push(definition),
    has: () => false,
    get: () => {
      throw new Error("No service instances in bootstrap registration test");
    },
  };
  const diagnostics = wireRuntimeObservability({
    container,
    statePath,
    workspaceId: "workspace-1",
    eventService: { emit: vi.fn() },
  });
  return { managed, rpc, diagnostics };
}

describe("wireRuntimeObservability", () => {
  it("registers the build bridge before the two diagnostics ingress services", () => {
    const { managed, rpc } = captureBootstrap();

    expect(managed.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      { name: "buildDiagnosticsBridge", dependencies: ["buildSystem"] },
    ]);
    expect(rpc.map((definition) => definition.name)).toEqual(["workerLog", "panelLog"]);
  });

  it("records completed build events in the shared diagnostics store", async () => {
    const { managed, diagnostics } = captureBootstrap();
    let onBuildEvent: ((event: { type: string; name: string; buildKey?: string }) => void) | null =
      null;
    const unsubscribe = vi.fn();
    const buildSystem = {
      onBuildEvent(listener: typeof onBuildEvent) {
        onBuildEvent = listener;
        return unsubscribe;
      },
      getGraph: () => ({
        tryGet: () => ({ kind: "worker", relativePath: "workers/example" }),
      }),
    } as unknown as BuildSystemV2;
    const bridge = managed[0];

    await bridge?.start?.(<D>(name: string): D | undefined =>
      name === "buildSystem" ? (buildSystem as D) : undefined
    );
    expect(onBuildEvent).not.toBeNull();
    const emitBuildEvent = onBuildEvent as unknown as (event: {
      type: "build-complete";
      name: string;
      buildKey: string;
    }) => void;
    emitBuildEvent({ type: "build-complete", name: "example", buildKey: "build-1" });

    expect(diagnostics.history("workers/example").entries).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "worker",
        level: "info",
        message: "Build complete (build-1)",
      }),
    ]);
    await bridge?.stop?.(unsubscribe);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

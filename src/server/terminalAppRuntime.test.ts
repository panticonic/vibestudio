import { describe, expect, it, vi } from "vitest";
import type { AppRegistryEntry } from "./appHost.js";
import { TerminalAppRuntime } from "./terminalAppRuntime.js";

describe("TerminalAppRuntime startup failures", () => {
  it("rejects unavailable runner setup and publishes the same failure as app status", async () => {
    const entry: AppRegistryEntry = {
      unitKind: "app",
      name: "@workspace-apps/terminal",
      version: "1.0.0",
      source: { kind: "workspace-repo", repo: "apps/terminal", ref: "main" },
      installedAt: 1,
      activeEv: "ev-terminal",
      activeSourceHash: "state:terminal",
      activeBundleKey: "build-terminal",
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "running",
      lastError: null,
      target: "terminal",
      capabilities: [],
      previousVersions: [],
    };
    const status = vi.fn();
    const registry = {
      get: vi.fn((name: string) => (name === entry.name ? entry : null)),
      list: vi.fn(() => [entry]),
      patch: vi.fn((_name: string, patch: Partial<AppRegistryEntry>) =>
        Object.assign(entry, patch)
      ),
    };
    const runtime = new TerminalAppRuntime({
      workspaceId: "workspace-test",
      registry,
      buildSystem: { getBuildByKey: vi.fn(() => null) },
      diagnostics: {
        record: vi.fn(),
        history: () => ({
          entries: [],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        }),
      },
      getGatewayUrl: () => "http://127.0.0.1:1234",
      validateBuild: vi.fn(),
      emitStatus: status,
    });

    let failure: unknown;
    try {
      await runtime.start(entry);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Terminal app runner is not configured");
    expect(entry).toMatchObject({
      status: "error",
      lastError: "Terminal app runner is not configured",
    });
    expect(status).toHaveBeenCalledWith(
      entry.name,
      "error",
      "Terminal app runner is not configured"
    );
  });
});

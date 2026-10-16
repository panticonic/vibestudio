import { describe, expect, it, vi } from "vitest";
import type { ClientHost } from "../clients/clientRegistry.js";
import { createClientUnitDriver } from "./clientUnitDriver.js";

const NAME = "@workspace-clients/desktop-browser";

function row(overrides: Record<string, unknown> = {}) {
  return {
    name: NAME,
    source: "clients/desktop-browser",
    displayName: "Shell",
    status: "running",
    activeBundleKey: "build-1",
    activeEv: "ev-1",
    lastError: null,
    ...overrides,
  };
}

function driverFor(
  host: Partial<Record<keyof ClientHost, unknown>> & { rows?: ReturnType<typeof row>[] },
  history = vi.fn(() => ({
    entries: [],
    errors: [],
    dropped: { entries: 0, errors: 0 },
    capacity: { entries: 1000, errors: 500 },
  }))
) {
  const rows = host.rows ?? [row()];
  const fake = {
    listWorkspaceUnits: () => rows,
    registry: { get: () => ({ activeExecutionDigest: "digest-1" }) },
    reannounce: vi.fn(),
    retire: vi.fn(),
    ...host,
  } as unknown as ClientHost;
  return {
    driver: createClientUnitDriver({ getHost: () => fake, diagnostics: { history } }),
    fake,
    history,
  };
}

describe("client unit supervision", () => {
  it("returns exact log and error buffers with store metadata from one snapshot", async () => {
    const history = vi.fn(() => ({
      entries: [
        {
          entityId: NAME,
          kind: "client" as const,
          timestamp: 1,
          level: "info" as const,
          message: "started",
          source: "runner" as const,
        },
      ],
      errors: [
        {
          entityId: NAME,
          kind: "client" as const,
          timestamp: 2,
          level: "error" as const,
          message: "build failed",
          source: "stderr" as const,
        },
      ],
      dropped: { entries: 3, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const { driver } = driverFor({}, history);

    expect(await driver.health(NAME)).toMatchObject({
      entity: { identity: { kind: "client", entityId: NAME } },
      logs: [{ message: "started", source: "runner" }],
      errors: [{ message: "build failed", source: "stderr" }],
      dropped: { entries: 3, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    });
    expect(history).toHaveBeenCalledExactlyOnceWith(NAME, undefined);
  });

  it("describes the adopted release with its sealed execution digest", () => {
    const { driver } = driverFor({});
    expect(driver.describe(NAME)).toMatchObject({
      identity: { kind: "client", entityId: NAME },
      release: { kind: "client", releaseId: NAME },
      source: "clients/desktop-browser",
      status: "running",
      artifact: { effectiveVersion: "ev-1", buildKey: "build-1", executionDigest: "digest-1" },
      facets: { activation: true, release: true, inspector: false },
    });
  });

  it("keeps a client running when only a newer build failed", async () => {
    const { driver } = driverFor({ rows: [row({ lastError: "newer build failed" })] });
    expect(driver.describe(NAME)).toMatchObject({
      status: "running",
      lastError: "newer build failed",
    });
    expect((await driver.health(NAME)).state).toBe("degraded");
  });

  it("does not describe a client without an adopted build", () => {
    const { driver } = driverFor({ rows: [row({ activeBundleKey: null })] });
    expect(driver.describe(NAME)).toBeNull();
    expect(driver.list()).toEqual([]);
    expect(() => driver.logs(NAME)).toThrow(/No running client exists/u);
  });

  it("restarts by announcing the current build again", async () => {
    const { driver, fake } = driverFor({});
    await driver.restart({} as never, NAME);
    expect(fake.reannounce).toHaveBeenCalledWith(NAME);
  });

  it("reports an open review instead of activating", async () => {
    const { driver } = driverFor({ ensureActivated: vi.fn(async () => "approval-required") });
    await expect(driver.activation!.activate({} as never, NAME)).resolves.toEqual({
      status: "approval-required",
    });
  });

  it("is unavailable outside the System workspace", () => {
    const driver = createClientUnitDriver({
      getHost: () => null,
      diagnostics: { history: vi.fn() },
    });
    expect(() => driver.list()).toThrow("Clients run only from the System workspace");
  });
});

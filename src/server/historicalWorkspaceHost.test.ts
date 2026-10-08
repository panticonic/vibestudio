import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveHistoricalWorkspaceHost,
  semverMajor,
  requireCompatibleTransitionHost,
} from "./historicalWorkspaceHost.js";

describe("historical workspace host", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("derives epochs from SemVer majors", () => {
    expect(semverMajor("0.1.18")).toBe(0);
    expect(semverMajor("2.0.0-beta.1")).toBe(2);
  });

  it("resolves only a complete matching epoch directory", () => {
    const versions = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hosts-"));
    roots.push(versions);
    const root = path.join(versions, "2");
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    for (const file of ["runtime/node", "runtime/server.mjs"])
      fs.writeFileSync(path.join(root, file), "");
    fs.writeFileSync(
      path.join(root, "workspace-host.json"),
      JSON.stringify({
        version: 2,
        systemEpoch: 2,
        appVersion: "2.3.4",
        executable: "runtime/node",
        runtimeMode: "node",
        serverEntry: "runtime/server.mjs",
        appRoot: "runtime",
      })
    );
    expect(resolveHistoricalWorkspaceHost(versions, 2)).toMatchObject({
      systemEpoch: 2,
      appVersion: "2.3.4",
      historical: true,
    });
    expect(() => resolveHistoricalWorkspaceHost(versions, 1)).toThrow(/unavailable or invalid/u);
    fs.rmSync(path.join(root, "runtime/node"));
    try {
      resolveHistoricalWorkspaceHost(versions, 2);
      expect.fail("Missing runtime must not resolve");
    } catch (error) {
      expect((error as Error).message).toContain("another workspace");
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toContain("executable is missing");
    }
  });
});

it("checks the minimum release of the actual target host before an epoch handoff", () => {
  const historical = vi.fn(() => ({ appVersion: "1.1.0" }) as never);
  expect(() =>
    requireCompatibleTransitionHost({
      requirement: { systemEpoch: 1, minimumAppVersion: "1.2.0" },
      currentAppVersion: "2.0.0",
      historical,
    })
  ).toThrow("1.2.0");
  expect(
    requireCompatibleTransitionHost({
      requirement: { systemEpoch: 2, minimumAppVersion: "2.1.0" },
      currentAppVersion: "2.1.0",
      historical,
    })
  ).toBe("2.1.0");
  expect(() =>
    requireCompatibleTransitionHost({
      requirement: { systemEpoch: 2, minimumAppVersion: "2.1.0" },
      currentAppVersion: "2.0.0",
      historical,
    })
  ).toThrow("2.1.0");
});

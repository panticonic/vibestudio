import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHistoricalWorkspaceHost, semverMajor } from "./historicalWorkspaceHost.js";

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
  });
});

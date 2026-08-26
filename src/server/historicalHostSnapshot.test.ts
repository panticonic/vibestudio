import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishHistoricalHostSnapshot } from "../../scripts/historical-host-snapshot.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-snapshot-test-"));
  roots.push(root);
  const app = path.join(root, "installed");
  const central = path.join(root, "state");
  fs.mkdirSync(path.join(app, "dist"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(app, "dist", "server.mjs"), content);
  const executable = path.join(root, "node");
  fs.writeFileSync(executable, "runtime");
  fs.chmodSync(executable, 0o500);
  return { app, central, executable };
}

describe("historical host snapshots", () => {
  it("publishes a self-contained epoch directory with its marker", () => {
    const input = fixture("2.4.1", "first");
    const result = publishHistoricalHostSnapshot({
      centralDataPath: input.central,
      artifactRoot: input.app,
      appRoot: input.app,
      serverEntry: path.join(input.app, "dist", "server.mjs"),
      executable: input.executable,
      appVersion: "2.4.1",
    });

    expect(result.destination).toBe(path.join(input.central, "host-versions", "2"));
    expect(
      fs.readFileSync(path.join(result.destination, "app", "dist", "server.mjs"), "utf8")
    ).toBe("first");
    expect(
      JSON.parse(fs.readFileSync(path.join(result.destination, "workspace-host.json"), "utf8"))
    ).toMatchObject({
      systemEpoch: 2,
      appVersion: "2.4.1",
      appRoot: "app",
      serverEntry: path.join("app", "dist", "server.mjs"),
    });
  });

  it("replaces an epoch with the final compatible patch", () => {
    const input = fixture("2.4.1", "first");
    const publish = (version: string) =>
      publishHistoricalHostSnapshot({
        centralDataPath: input.central,
        artifactRoot: input.app,
        appRoot: input.app,
        serverEntry: path.join(input.app, "dist", "server.mjs"),
        executable: input.executable,
        appVersion: version,
      });
    publish("2.4.1");
    fs.writeFileSync(path.join(input.app, "dist", "server.mjs"), "final");
    publish("2.9.0");

    const destination = path.join(input.central, "host-versions", "2");
    expect(fs.readFileSync(path.join(destination, "app", "dist", "server.mjs"), "utf8")).toBe(
      "final"
    );
    expect(fs.existsSync(path.join(input.central, "host-versions", ".2.previous"))).toBe(false);
  });
});

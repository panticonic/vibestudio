import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "./centralData.js";

describe("CentralDataManager", () => {
  let tempRoot: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-central-data-"));
    originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tempRoot;
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("repairs a missing registry entry when touching an existing workspace", () => {
    const configPath = path.join(
      tempRoot,
      "vibestudio",
      "workspaces",
      "client",
      "source",
      "meta",
      "vibestudio.yml"
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "id: client\n", "utf8");

    const manager = new CentralDataManager();
    expect(manager.getWorkspaceEntry("client")).toBeNull();

    manager.touchWorkspace("client");

    expect(manager.getWorkspaceEntry("client")).toMatchObject({ name: "client" });
    expect(manager.getLastWorkspaceTarget()).toMatchObject({ kind: "local", name: "client" });
  });

  it("does not add a registry entry when touching a missing workspace", () => {
    const manager = new CentralDataManager();

    manager.touchWorkspace("missing");

    expect(manager.getWorkspaceEntry("missing")).toBeNull();
    expect(manager.listWorkspaces()).toEqual([]);
  });

  function seedWorkspaceDir(name: string): void {
    const configPath = path.join(
      tempRoot,
      "vibestudio",
      "workspaces",
      name,
      "source",
      "meta",
      "vibestudio.yml"
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `id: ${name}\n`, "utf8");
  }

  const localServer = {
    gatewayPort: 4321,
    pid: 999,
    serverId: "srv-1",
    serverBootId: "boot-1",
    startedAt: 1234,
    version: "1.0.0",
  };

  it("records, reads, and clears a workspace local server attachment", () => {
    seedWorkspaceDir("client");
    const manager = new CentralDataManager();

    manager.setWorkspaceLocalServer("client", localServer);
    expect(manager.getWorkspaceLocalServer("client")).toEqual(localServer);

    manager.clearWorkspaceLocalServer("client");
    expect(manager.getWorkspaceLocalServer("client")).toBeNull();
  });

  it("creates the entry when recording a local server for an on-disk-but-unregistered workspace", () => {
    seedWorkspaceDir("client");
    const manager = new CentralDataManager();
    expect(manager.getWorkspaceEntry("client")).toBeNull();

    manager.setWorkspaceLocalServer("client", localServer);

    expect(manager.getWorkspaceEntry("client")).toMatchObject({ name: "client", localServer });
  });

  it("no-ops recording a local server for a missing workspace", () => {
    const manager = new CentralDataManager();

    manager.setWorkspaceLocalServer("missing", localServer);

    expect(manager.getWorkspaceEntry("missing")).toBeNull();
  });

  it("sees a local server record written to disk by another process", () => {
    seedWorkspaceDir("client");
    const writer = new CentralDataManager();
    writer.setWorkspaceLocalServer("client", localServer);

    const reader = new CentralDataManager();
    // Simulate a concurrent write from another process.
    writer.setWorkspaceLocalServer("client", { ...localServer, pid: 4242 });

    expect(reader.getWorkspaceLocalServer("client")).toMatchObject({ pid: 4242 });
  });
});

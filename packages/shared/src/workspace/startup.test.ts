import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralDataManager } from "../centralData.js";
import { initWorkspace } from "./loader.js";
import { resolveLocalWorkspaceStartup } from "./startup.js";

const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const tempRoots: string[] = [];

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-startup-"));
  tempRoots.push(root);
  process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
  const templateDir = path.join(root, "workspace");
  fs.mkdirSync(path.join(templateDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(templateDir, "meta", "vibestudio.yml"), "initPanels: []\n");
  const centralData = new CentralDataManager({
    databasePath: path.join(root, "identity.db"),
    now: () => 123,
  });
  const workspaceDir = (name: string) =>
    path.join(process.env["XDG_CONFIG_HOME"]!, "vibestudio", "workspaces", name);
  return { root, templateDir, centralData, workspaceDir };
}

describe("resolveLocalWorkspaceStartup current lifecycle", () => {
  it("creates and registers a selected workspace as one compensated operation", () => {
    const { root, centralData, workspaceDir } = setup();
    try {
      const result = resolveLocalWorkspaceStartup({
        appRoot: root,
        centralData,
        name: "alpha",
        init: true,
      });

      expect(result.resolved.created).toBe(true);
      expect(result.resolved.wsDir).toBe(workspaceDir("alpha"));
      expect(centralData.getWorkspaceEntry("alpha")).toMatchObject({ name: "alpha" });
    } finally {
      centralData.close();
    }
  });

  it("rejects an unregistered directory instead of adopting it", () => {
    const { root, templateDir, centralData, workspaceDir } = setup();
    try {
      initWorkspace("orphan", { templateDir });

      expect(() =>
        resolveLocalWorkspaceStartup({
          appRoot: root,
          centralData,
          name: "orphan",
          init: true,
        })
      ).toThrow(/Workspace directory already exists/);
      expect(centralData.hasWorkspace("orphan")).toBe(false);
      expect(fs.existsSync(workspaceDir("orphan"))).toBe(true);
    } finally {
      centralData.close();
    }
  });

  it("removes a newly published workspace when registration fails", () => {
    const { root, centralData, workspaceDir } = setup();
    const add = vi.spyOn(centralData, "addWorkspace").mockImplementationOnce(() => {
      throw new Error("injected registration failure");
    });
    try {
      expect(() =>
        resolveLocalWorkspaceStartup({
          appRoot: root,
          centralData,
          name: "broken",
          init: true,
        })
      ).toThrow(/injected registration failure/);
      expect(fs.existsSync(workspaceDir("broken"))).toBe(false);
    } finally {
      add.mockRestore();
      centralData.close();
    }
  });

  it("reserves explicit directories for hub-managed child startup", () => {
    const { root, centralData } = setup();
    try {
      expect(() =>
        resolveLocalWorkspaceStartup({
          appRoot: root,
          centralData,
          wsDir: path.join(root, "external"),
        })
      ).toThrow(/reserved for hub-managed child runtimes/);
    } finally {
      centralData.close();
    }
  });
});

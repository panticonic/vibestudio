import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createAndRegisterWorkspace,
  deleteAndUnregisterWorkspace,
  deleteUnregisteredWorkspace,
  initWorkspace,
  loadCentralConfig,
  loadWorkspaceConfig,
  recoverStagedWorkspaceDeletions,
  resolveDeclaredApps,
  resolveDeclaredExtensions,
  resolveOrCreateWorkspace,
  saveCentralConfig,
} from "./loader.js";
import { CentralDataManager } from "../centralData.js";

const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const tempRoots: string[] = [];

function writeConfig(sourceRoot: string, content: string): void {
  fs.mkdirSync(path.join(sourceRoot, "meta"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "meta", "vibestudio.yml"), content, "utf-8");
}

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("loadWorkspaceConfig", () => {
  (process.platform === "linux" ? it : it.skip)(
    "derives the workspace id from the managed workspace folder name",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
      tempRoots.push(root);
      process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

      const sourceRoot = path.join(
        process.env["XDG_CONFIG_HOME"],
        "vibestudio",
        "workspaces",
        "cloned-ws",
        "source"
      );
      writeConfig(sourceRoot, "initPanels: []\n");

      expect(loadWorkspaceConfig(sourceRoot).id).toBe("cloned-ws");
    }
  );

  it("derives the workspace id from the absolute workspace root for unmanaged paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, "external-workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    writeConfig(sourceRoot, "initPanels: []\n");

    expect(loadWorkspaceConfig(sourceRoot).id).toBe(workspaceRoot);
  });

  it("ignores an explicit workspace id when one is configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    writeConfig(sourceRoot, "id: explicit\ninitPanels: []\n");

    expect(loadWorkspaceConfig(sourceRoot).id).toBe(workspaceRoot);
  });

  it("rejects .git-suffixed extension declarations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: extensions/a.git\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/extensions\[\]\.source/);
  });

  it("rejects duplicate extension declarations across source-root and package-name forms", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(
      sourceRoot,
      'extensions:\n  - source: extensions/a\n  - source: "@workspace-extensions/a"\n'
    );

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate extension/);
  });

  it("rejects extension declarations outside the extension source root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: apps/shell\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /extensions\[\]\.source.*extensions\/name/
    );
  });

  it("rejects nested extension source paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: extensions/react-native/nested\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /extensions\[\]\.source.*@workspace-extensions\/name/
    );
  });

  it("rejects retired workspace-prefixed unit declarations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: workspace/extensions/react-native\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/extensions\[\]\.source/);
  });

  it("rejects extension declarations without a source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - ref: main\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/non-empty `source`/);
  });

  it("rejects .git-suffixed app declarations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: apps/shell.git\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/apps\[\]\.source/);
  });

  it("rejects duplicate app declarations across source-root and package-name forms", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, 'apps:\n  - source: apps/shell\n  - source: "@workspace-apps/shell"\n');

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate app/);
  });

  it("rejects app declarations outside the app source root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: extensions/react-native\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/apps\[\]\.source.*apps\/name/);
  });

  it("rejects unscoped app package names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: shell\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /apps\[\]\.source.*@workspace-apps\/name/
    );
  });
});

describe("central config", () => {
  function useCentralConfig(content?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-central-config-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const configPath = path.join(process.env["XDG_CONFIG_HOME"], "vibestudio", "config.yml");
    if (content !== undefined) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, content);
    }
    return configPath;
  }

  (process.platform === "linux" ? it : it.skip)(
    "loads only the exact current models/cache structure",
    () => {
      useCentralConfig(
        [
          "models:",
          "  coding: openai:gpt-5",
          "  review:",
          "    provider: anthropic",
          "    model: claude-opus",
          "    temperature: 0.2",
          "cache:",
          "  maxEntries: 100",
          "  maxSize: 1024",
          "  expirationMs: 0",
        ].join("\n")
      );

      expect(loadCentralConfig()).toEqual({
        models: {
          coding: "openai:gpt-5",
          review: { provider: "anthropic", model: "claude-opus", temperature: 0.2 },
        },
        cache: { maxEntries: 100, maxSize: 1024, expirationMs: 0 },
      });
    }
  );

  (process.platform === "linux" ? it : it.skip)(
    "rejects the retired direct-remote structure and all unknown root keys",
    () => {
      useCentralConfig("remote:\n  url: https://old.example\n  token: admin-secret\n");
      expect(() => loadCentralConfig()).toThrow(/Failed to load central config/);

      useCentralConfig("models: {}\nunknown: true\n");
      expect(() => loadCentralConfig()).toThrow(/Failed to load central config/);
    }
  );

  (process.platform === "linux" ? it : it.skip)(
    "rejects unknown nested keys on load and save",
    () => {
      useCentralConfig(
        "models:\n  coding:\n    provider: openai\n    model: gpt-5\n    oldField: true\n"
      );
      expect(() => loadCentralConfig()).toThrow(/Failed to load central config/);
      expect(() =>
        saveCentralConfig({ cache: { maxEntries: 1 }, legacy: true } as never)
      ).toThrow();
    }
  );
});

describe("resolveDeclaredExtensions", () => {
  it("returns an empty list when no extensions section exists", () => {
    expect(resolveDeclaredExtensions({ id: "ws" })).toEqual([]);
  });

  it("applies ref defaults", () => {
    expect(
      resolveDeclaredExtensions({
        id: "ws",
        extensions: [{ source: "extensions/a" }, { source: "@workspace-extensions/b", ref: "dev" }],
      })
    ).toEqual([
      { source: "extensions/a", ref: "main" },
      { source: "@workspace-extensions/b", ref: "dev" },
    ]);
  });
});

describe("resolveDeclaredApps", () => {
  it("returns an empty list when no apps section exists", () => {
    expect(resolveDeclaredApps({ id: "ws" })).toEqual([]);
  });

  it("applies ref defaults", () => {
    expect(
      resolveDeclaredApps({
        id: "ws",
        apps: [
          { source: "apps/shell" },
          {
            source: "@workspace-apps/mobile",
            ref: "dev",
          },
        ],
      })
    ).toEqual([
      { source: "apps/shell", ref: "main" },
      {
        source: "@workspace-apps/mobile",
        ref: "dev",
      },
    ]);
  });
});

describe("initWorkspace", () => {
  (process.platform === "linux" ? it : it.skip)(
    "copies canonical app units from the workspace template",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
      tempRoots.push(root);
      process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
      const templateRoot = path.join(root, "workspace-template");
      writeConfig(
        templateRoot,
        [
          "extensions:",
          "  - source: extensions/react-native",
          "apps:",
          "  - source: apps/shell",
          "  - source: apps/mobile",
          "initPanels: []",
          "",
        ].join("\n")
      );
      fs.mkdirSync(path.join(templateRoot, "apps", "shell"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "apps", "shell", "package.json"),
        JSON.stringify({
          name: "@workspace-apps/shell",
          version: "0.1.0",
          vibestudio: {
            app: {
              target: "electron",
              renderer: "index.tsx",
              capabilities: ["panel-hosting", "incoming-pair-links"],
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "apps", "shell", "index.tsx"),
        "export const templateShell = true;\n"
      );
      fs.mkdirSync(path.join(templateRoot, "apps", "mobile"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "apps", "mobile", "package.json"),
        JSON.stringify({
          name: "@workspace-apps/mobile",
          version: "0.1.0",
          vibestudio: {
            app: {
              target: "react-native",
              renderer: "App.tsx",
              rnComponentName: "Vibestudio",
              rnHostAbi: "rn-host-2",
              capabilities: ["notifications", "camera", "keychain", "clipboard", "open-external"],
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "apps", "mobile", "App.tsx"),
        "export const templateMobile = true;\n"
      );
      fs.mkdirSync(path.join(templateRoot, "extensions", "react-native"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "extensions", "react-native", "package.json"),
        JSON.stringify({
          name: "@workspace-extensions/react-native",
          version: "0.1.0",
          vibestudio: {
            extension: {
              activationEvents: ["*"],
              streamingMethods: ["buildArtifact"],
              contributes: { buildTargets: ["react-native"] },
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "extensions", "react-native", "index.ts"),
        "export const templateProvider = true;\n"
      );

      initWorkspace("fresh-app-ws", { templateDir: templateRoot });

      const sourceRoot = path.join(
        process.env["XDG_CONFIG_HOME"],
        "vibestudio",
        "workspaces",
        "fresh-app-ws",
        "source"
      );
      const config = loadWorkspaceConfig(sourceRoot);

      expect(resolveDeclaredApps(config)).toEqual([
        { source: "apps/shell", ref: "main" },
        {
          source: "apps/mobile",
          ref: "main",
        },
      ]);
      expect(resolveDeclaredExtensions(config)).toEqual([
        { source: "extensions/react-native", ref: "main" },
      ]);
      expect(fs.existsSync(path.join(sourceRoot, "apps", "shell", ".git"))).toBe(false);
      expect(fs.existsSync(path.join(sourceRoot, "apps", "mobile", ".git"))).toBe(false);
      expect(fs.existsSync(path.join(sourceRoot, "extensions", "react-native", ".git"))).toBe(
        false
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(sourceRoot, "apps", "shell", "package.json"), "utf-8"))
      ).toMatchObject({
        name: "@workspace-apps/shell",
        vibestudio: {
          app: {
            target: "electron",
            renderer: "index.tsx",
            capabilities: expect.arrayContaining(["panel-hosting", "incoming-pair-links"]),
          },
        },
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(sourceRoot, "apps", "mobile", "package.json"), "utf-8")
        )
      ).toMatchObject({
        name: "@workspace-apps/mobile",
        vibestudio: {
          app: {
            target: "react-native",
            renderer: "App.tsx",
            rnComponentName: "Vibestudio",
            rnHostAbi: "rn-host-2",
            capabilities: expect.arrayContaining([
              "notifications",
              "camera",
              "keychain",
              "clipboard",
              "open-external",
            ]),
          },
        },
      });
      expect(
        fs.readFileSync(path.join(sourceRoot, "apps", "shell", "index.tsx"), "utf-8")
      ).toContain("templateShell");
      expect(
        fs.readFileSync(path.join(sourceRoot, "apps", "mobile", "App.tsx"), "utf-8")
      ).toContain("templateMobile");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(sourceRoot, "extensions", "react-native", "package.json"),
            "utf-8"
          )
        )
      ).toMatchObject({
        name: "@workspace-extensions/react-native",
        vibestudio: {
          extension: {
            streamingMethods: ["buildArtifact"],
            contributes: { buildTargets: ["react-native"] },
          },
        },
      });
      const providerSource = fs.readFileSync(
        path.join(sourceRoot, "extensions", "react-native", "index.ts"),
        "utf-8"
      );
      expect(providerSource).toContain("templateProvider");
    }
  );

  (process.platform === "linux" ? it : it.skip)("requires a template or fork", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

    expect(() => initWorkspace("missing-template")).toThrow(/requires a templateDir or forkFrom/);
  });

  it("publishes only a fully validated workspace and removes its staging directory on failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "invalid-template");
    writeConfig(templateRoot, "initPanels: [\n");

    expect(() => initWorkspace("invalid-workspace", { templateDir: templateRoot })).toThrow();

    const workspacesDir = path.join(process.env["XDG_CONFIG_HOME"], "vibestudio", "workspaces");
    expect(fs.existsSync(path.join(workspacesDir, "invalid-workspace"))).toBe(false);
    expect(fs.readdirSync(workspacesDir)).toEqual([]);
  });

  it("removes staging state when the atomic publish rename fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected rename failure");
    });

    try {
      expect(() => initWorkspace("rename-failure", { templateDir: templateRoot })).toThrow(
        /injected rename failure/
      );
    } finally {
      rename.mockRestore();
    }

    const workspacesDir = path.join(process.env["XDG_CONFIG_HOME"], "vibestudio", "workspaces");
    expect(fs.readdirSync(workspacesDir)).toEqual([]);
  });

  it("rejects an existing partial final directory without deleting or adopting it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "workspace-template");
    writeConfig(templateRoot, "initPanels: []\n");
    const workspaceDir = path.join(
      process.env["XDG_CONFIG_HOME"],
      "vibestudio",
      "workspaces",
      "partial"
    );
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "operator-data.txt"), "keep");

    expect(() => resolveOrCreateWorkspace({ name: "partial", appRoot: root, init: true })).toThrow(
      /Workspace directory already exists/
    );
    expect(fs.readFileSync(path.join(workspaceDir, "operator-data.txt"), "utf-8")).toBe("keep");
  });

  it("compensates a failed registry write by removing the published directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    const centralData = {
      hasWorkspace: () => false,
      addWorkspace: () => {
        throw new Error("injected registry failure");
      },
    } as unknown as CentralDataManager;

    expect(() =>
      createAndRegisterWorkspace("registration-failure", centralData, {
        templateDir: templateRoot,
      })
    ).toThrow(/injected registry failure/);

    const workspacesDir = path.join(process.env["XDG_CONFIG_HOME"], "vibestudio", "workspaces");
    expect(fs.readdirSync(workspacesDir)).toEqual([]);
  });

  it("restores the workspace directory when the registry deletion transaction fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    initWorkspace("delete-failure", { templateDir: templateRoot });
    const workspaceDir = path.join(
      process.env["XDG_CONFIG_HOME"],
      "vibestudio",
      "workspaces",
      "delete-failure"
    );
    fs.writeFileSync(path.join(workspaceDir, "operator-data.txt"), "keep");
    const centralData = {
      getWorkspaceEntry: () => ({
        name: "delete-failure",
        workspaceId: "ws_delete_failure",
        lastOpened: 1,
      }),
      removeWorkspace: () => {
        throw new Error("injected registry deletion failure");
      },
    } as unknown as CentralDataManager;

    expect(() => deleteAndUnregisterWorkspace("delete-failure", centralData)).toThrow(
      /injected registry deletion failure/
    );
    expect(fs.readFileSync(path.join(workspaceDir, "operator-data.txt"), "utf-8")).toBe("keep");
    expect(
      fs
        .readdirSync(path.dirname(workspaceDir))
        .filter((entry) => entry.startsWith(".delete-delete-failure-"))
    ).toEqual([]);
  });

  it("leaves registry and workspace untouched when the delete staging rename fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    initWorkspace("delete-rename-failure", { templateDir: templateRoot });
    const workspaceDir = path.join(
      process.env["XDG_CONFIG_HOME"],
      "vibestudio",
      "workspaces",
      "delete-rename-failure"
    );
    const removeWorkspace = vi.fn(() => "ws_delete_rename_failure");
    const centralData = {
      getWorkspaceEntry: () => ({
        name: "delete-rename-failure",
        workspaceId: "ws_delete_rename_failure",
        lastOpened: 1,
      }),
      removeWorkspace,
    } as unknown as CentralDataManager;
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected delete rename failure");
    });

    try {
      expect(() => deleteAndUnregisterWorkspace("delete-rename-failure", centralData)).toThrow(
        /injected delete rename failure/
      );
    } finally {
      rename.mockRestore();
    }

    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspaceDir, "source", "meta", "vibestudio.yml"))).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(workspaceDir))
        .filter((entry) => entry.startsWith(".delete-delete-rename-failure-"))
    ).toEqual([]);
  });

  it("returns committed deletion success and durably retries post-commit cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    const centralData = new CentralDataManager({ databasePath: path.join(root, "identity.db") });
    const workspace = createAndRegisterWorkspace("cleanup-retry", centralData, {
      templateDir: templateRoot,
    });
    const workspacesDir = path.join(process.env["XDG_CONFIG_HOME"], "vibestudio", "workspaces");
    const originalRmSync = fs.rmSync.bind(fs);
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.basename(String(target)).startsWith(".delete-cleanup-retry-")) {
        throw new Error("injected post-commit cleanup failure");
      }
      return originalRmSync(target, options);
    });

    try {
      expect(deleteAndUnregisterWorkspace("cleanup-retry", centralData)).toBe(
        workspace.workspaceId
      );
    } finally {
      rm.mockRestore();
    }

    expect(centralData.getWorkspaceEntry("cleanup-retry")).toBeNull();
    expect(fs.existsSync(path.join(workspacesDir, "cleanup-retry"))).toBe(false);
    expect(
      fs.readdirSync(workspacesDir).filter((name) => name.startsWith(".delete-cleanup-retry-"))
    ).toHaveLength(1);

    expect(recoverStagedWorkspaceDeletions(centralData)).toEqual({
      finalized: ["cleanup-retry"],
      restored: [],
      failures: [],
    });
    expect(
      fs.readdirSync(workspacesDir).filter((name) => name.startsWith(".delete-cleanup-retry-"))
    ).toEqual([]);
    centralData.close();
  });

  it("keeps the ephemeral disk-only cleanup path from deleting registered workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    initWorkspace("dev-deadbeef", { templateDir: templateRoot });
    const workspaceDir = path.join(
      process.env["XDG_CONFIG_HOME"],
      "vibestudio",
      "workspaces",
      "dev-deadbeef"
    );
    const registered = { hasWorkspace: () => true } as unknown as CentralDataManager;

    expect(() => deleteUnregisteredWorkspace("dev-deadbeef", registered)).toThrow(
      /is registered and must be deleted with deleteAndUnregisterWorkspace/
    );
    expect(fs.existsSync(workspaceDir)).toBe(true);

    const unregistered = { hasWorkspace: () => false } as unknown as CentralDataManager;
    expect(deleteUnregisteredWorkspace("dev-deadbeef", unregistered)).toBe(true);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(deleteUnregisteredWorkspace("dev-deadbeef", unregistered)).toBe(false);
  });

  it("completes the registered filesystem and control-data lifecycle as one operation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
    const templateRoot = path.join(root, "template");
    writeConfig(templateRoot, "initPanels: []\n");
    const databasePath = path.join(root, "identity.db");
    const centralData = new CentralDataManager({ databasePath });
    const entry = createAndRegisterWorkspace("full-lifecycle", centralData, {
      templateDir: templateRoot,
    });
    const db = new DatabaseSync(databasePath);
    db.prepare(
      `INSERT INTO users (id, handle, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("usr_member", "member", "Member", "member", 1);
    db.prepare(
      `INSERT INTO membership (user_id, workspace_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`
    ).run("usr_member", entry.workspaceId, "usr_member", 1);
    db.prepare(
      `INSERT INTO user_workspace_targets (user_id, workspace_id, last_opened)
       VALUES (?, ?, ?)`
    ).run("usr_member", entry.workspaceId, 1);
    const workspaceDir = path.join(
      process.env["XDG_CONFIG_HOME"],
      "vibestudio",
      "workspaces",
      "full-lifecycle"
    );

    expect(deleteAndUnregisterWorkspace("full-lifecycle", centralData)).toBe(entry.workspaceId);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(centralData.getWorkspaceEntry("full-lifecycle")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM membership").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_workspace_targets").get()).toEqual({
      count: 0,
    });
    expect(
      fs
        .readdirSync(path.dirname(workspaceDir))
        .filter((candidate) => candidate.startsWith(".delete-full-lifecycle-"))
    ).toEqual([]);
    db.close();
    centralData.close();
  });

  // The `.vibestudio-template-source.json` provenance marker was write-only (no
  // reader) and is removed by the per-repo reshape's cleanup; its test is gone.
});

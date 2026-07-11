import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadWorkspaceConfig,
  resolveOrCreateWorkspace,
  resolveDeclaredApps,
  resolveDeclaredExtensions,
} from "./loader.js";

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
              capabilities: ["panel-hosting", "incoming-pair-links", "connection-management"],
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
            capabilities: expect.arrayContaining([
              "panel-hosting",
              "incoming-pair-links",
              "connection-management",
            ]),
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

  // The `.vibestudio-template-source.json` provenance marker was write-only (no
  // reader) and is removed by the per-repo reshape's cleanup; its test is gone.
});

describe("resolveOrCreateWorkspace", () => {
  (process.platform === "linux" ? it : it.skip)(
    "reuses an empty interrupted-create directory without deleting non-empty workspaces",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-loader-"));
      tempRoots.push(root);
      process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

      const templateRoot = path.join(root, "workspace-template");
      writeConfig(templateRoot, "initPanels: []\n");

      const emptyWorkspace = path.join(
        process.env["XDG_CONFIG_HOME"],
        "vibestudio",
        "workspaces",
        "interrupted"
      );
      fs.mkdirSync(emptyWorkspace, { recursive: true });

      const resolved = resolveOrCreateWorkspace({
        name: "interrupted",
        appRoot: root,
        init: true,
      });

      expect(resolved.created).toBe(true);
      expect(resolved.workspace.config.id).toBe("interrupted");
      expect(fs.existsSync(path.join(emptyWorkspace, "source", "meta", "vibestudio.yml"))).toBe(
        true
      );

      const occupiedWorkspace = path.join(
        process.env["XDG_CONFIG_HOME"],
        "vibestudio",
        "workspaces",
        "occupied"
      );
      fs.mkdirSync(occupiedWorkspace, { recursive: true });
      const recoveryFile = path.join(occupiedWorkspace, "recover-me.txt");
      fs.writeFileSync(recoveryFile, "important\n");

      expect(() =>
        resolveOrCreateWorkspace({ name: "occupied", appRoot: root, init: true })
      ).toThrow(/existing files were not changed/);
      expect(fs.readFileSync(recoveryFile, "utf8")).toBe("important\n");
    }
  );
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  hasDependencyWorkspaceMetadata,
  resolveDependencyWorkspaceRoot,
} from "./dependencyWorkspaceRoot.js";

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };

describe("resolveDependencyWorkspaceRoot", () => {
  let root: string;
  let originalResourcesPath: string | undefined;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "dep-workspace-root-"));
    originalResourcesPath = (process as ProcessWithResources).resourcesPath;
  });

  afterEach(async () => {
    if (originalResourcesPath === undefined) {
      Reflect.deleteProperty(process, "resourcesPath");
    } else {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        value: originalResourcesPath,
      });
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writeWorkspaceConfig(dir: string): Promise<void> {
    await fsp.mkdir(path.join(dir, "meta"), { recursive: true });
    await fsp.writeFile(path.join(dir, "meta", "vibez1.yml"), "panels: []\n");
  }

  it("uses the packaged workspace-template as the dependency root when it has dependency metadata", async () => {
    const appRoot = path.join(root, "app.asar");
    const resourcesRoot = path.join(root, "resources");
    const template = path.join(resourcesRoot, "workspace-template");
    const activeWorkspace = path.join(root, "workspaces", "user", "source");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: resourcesRoot,
    });

    await writeWorkspaceConfig(template);
    await fsp.writeFile(path.join(template, "package.json"), '{"name":"template"}\n');
    await fsp.writeFile(path.join(template, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fsp.mkdir(activeWorkspace, { recursive: true });
    await fsp.writeFile(path.join(activeWorkspace, "package.json"), '{"name":"active"}\n');

    expect(hasDependencyWorkspaceMetadata(template)).toBe(true);
    expect(resolveDependencyWorkspaceRoot(appRoot, activeWorkspace)).toBe(template);
  });

  it("falls back to the active workspace when the template has only source metadata", async () => {
    const appRoot = path.join(root, "app");
    const template = path.join(appRoot, "workspace-template");
    const activeWorkspace = path.join(root, "active");

    await writeWorkspaceConfig(template);
    await fsp.mkdir(activeWorkspace, { recursive: true });
    await fsp.writeFile(path.join(activeWorkspace, "pnpm-workspace.yaml"), "packages: []\n");

    expect(hasDependencyWorkspaceMetadata(template)).toBe(false);
    expect(resolveDependencyWorkspaceRoot(appRoot, activeWorkspace)).toBe(activeWorkspace);
  });

  it("returns the template for source resolution when neither side has dependency metadata", async () => {
    const appRoot = path.join(root, "app");
    const template = path.join(appRoot, "workspace-template");
    const activeWorkspace = path.join(root, "active");

    await writeWorkspaceConfig(template);
    await fsp.mkdir(activeWorkspace, { recursive: true });

    expect(resolveDependencyWorkspaceRoot(appRoot, activeWorkspace)).toBe(template);
  });
});

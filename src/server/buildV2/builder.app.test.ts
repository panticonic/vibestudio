import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import { buildUnit } from "./builder.js";
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";
beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));
import { discoverPackageGraph } from "./packageGraph.js";
import { clearBuildProvidersForTests, registerBuildProvider } from "./buildProviderRegistry.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

describe("buildUnit app builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-app-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    clearBuildProvidersForTests();
  });

  afterEach(() => {
    clearBuildProvidersForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rewrites Electron app HTML to the app artifact loader", async () => {
    const appDir = path.join(workspaceRoot, "apps", "shell");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/shell",
        version: "0.1.0",
        private: true,
        natstack: {
          app: {
            target: "electron",
            renderer: "index.ts",
            capabilities: ["incoming-pair-links"],
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(appDir, "index.ts"),
      "import './style.css'; document.body.dataset.ready = 'true';\n"
    );
    fs.writeFileSync(path.join(appDir, "style.css"), "body { color: red; }\n");
    fs.writeFileSync(
      path.join(appDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./bundle.css"></head><body><script type="module" src="./bundle.js"></script></body></html>'
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial app",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-apps/shell"),
      "ev-shell",
      graph,
      workspaceRoot,
      "state:test"
    );
    const html = result.artifacts.find((artifact) => artifact.path === "index.html")?.content;

    expect(html).toMatch(/type="module" src="\.\/bundle-[A-Za-z0-9]+\.js"/u);
    expect(html).not.toContain('src="/__loader.js"');
    expect(html).not.toContain("<base ");
    expect(html).not.toContain("renderer/index.js");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/^bundle-[A-Za-z0-9]+\.js$/u),
          role: "primary",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/^bundle-[A-Za-z0-9]+\.css$/u),
          role: "css",
        }),
      ])
    );
  });

  it("bundles terminal app targets as node entry artifacts", async () => {
    const rpcDir = path.join(workspaceRoot, "packages", "rpc");
    fs.mkdirSync(path.join(rpcDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(rpcDir, "package.json"),
      JSON.stringify({
        name: "@natstack/rpc",
        version: "0.1.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(rpcDir, "src", "index.ts"),
      "export function createHandlerRegistry() { return { ok: true }; }\n"
    );
    git(rpcDir, ["init", "-b", "main"]);
    git(rpcDir, ["add", "."]);
    git(rpcDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial rpc package",
    ]);
    const appDir = path.join(workspaceRoot, "apps", "remote-cli");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/remote-cli",
        version: "0.1.0",
        private: true,
        natstack: {
          app: {
            target: "terminal",
            entry: "index.ts",
            capabilities: ["connection-management"],
          },
        },
        dependencies: {
          "@natstack/rpc": "workspace:*",
          ws: "^8.18.3",
        },
      })
    );
    fs.writeFileSync(
      path.join(appDir, "index.ts"),
      [
        "import { createHandlerRegistry } from '@natstack/rpc';",
        "import WebSocket from 'ws';",
        "export function main() {",
        "  const registry = createHandlerRegistry();",
        "  return { label: 'remote-cli', hasWs: typeof WebSocket === 'function', registry };",
        "}",
        "",
      ].join("\n")
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial terminal app",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-apps/remote-cli"),
      "ev-cli",
      graph,
      workspaceRoot,
      "state:test"
    );

    expect(result.metadata.details).toMatchObject({ kind: "app", target: "terminal" });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "index.mjs", role: "primary" })])
    );
    const mod = (await import(pathToFileURL(path.join(result.dir, "index.mjs")).href)) as {
      main: () => { hasWs: boolean };
    };
    expect(mod.main()).toMatchObject({ hasWs: true });
  });

  it("routes React Native app builds through the registered build provider", async () => {
    const appDir = path.join(workspaceRoot, "apps", "mobile");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/mobile",
        version: "0.1.0",
        private: true,
        natstack: {
          app: {
            target: "react-native",
            renderer: "index.tsx",
            rnComponentName: "NatStackMobile",
            rnHostAbi: "rn-host-1",
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(appDir, "index.tsx"),
      "export default function App() { return null; }\n"
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial app",
    ]);

    registerBuildProvider({
      name: "@workspace-extensions/react-native-provider",
      target: "react-native",
      contractVersion: "1",
      activeEv: "ev-provider",
      activeBuildKey: "provider-build",
      build: async (_input) => ({
        artifacts: [
          {
            path: "ios/main.hbc",
            role: "primary",
            contentType: "application/octet-stream",
            encoding: "base64",
            platform: "ios",
            stream: { method: "buildArtifact", args: ["ios-main"] },
          },
        ],
        metadata: {
          rnHostAbi: "rn-host-1",
          platform: "ios",
        },
      }),
      streamArtifact: async (_artifact, input) =>
        new Response(`bundle:${input.unitName}:${input.effectiveVersion}`),
    });

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-apps/mobile"),
      "ev-mobile",
      graph,
      workspaceRoot,
      "state:test"
    );

    expect(result.metadata).toMatchObject({
      kind: "app",
      name: "@workspace-apps/mobile",
      sourceStateHash: "state:test",
      details: {
        kind: "app",
        target: "react-native",
        platform: "ios",
        integrity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
        rnHostAbi: "rn-host-1",
        provider: {
          name: "@workspace-extensions/react-native-provider",
          activeEv: "ev-provider",
          activeBuildKey: "provider-build",
          contractVersion: "1",
        },
      },
    });
    expect(result.sourceStateHash).toBe("state:test");
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: "ios/main.hbc",
        role: "primary",
        encoding: "base64",
        platform: "ios",
        integrity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
        content: Buffer.from("bundle:@workspace-apps/mobile:ev-mobile").toString("base64"),
      }),
    ]);
  });

  it("builds panel bundles that import fs through the runtime-backed shim", async () => {
    const runtimeDir = path.join(workspaceRoot, "packages", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        version: "0.1.0",
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
      })
    );
    fs.writeFileSync(path.join(runtimeDir, "index.ts"), "export const fs = {};\n");
    git(runtimeDir, ["init", "-b", "main"]);
    git(runtimeDir, ["add", "."]);
    git(runtimeDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial runtime",
    ]);

    const panelDir = path.join(workspaceRoot, "panels", "fs-panel");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/fs-panel",
        version: "0.1.0",
        private: true,
        type: "module",
        natstack: {
          title: "FS Panel",
          entry: "index.ts",
        },
        dependencies: {
          "@workspace/runtime": "workspace:*",
        },
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.ts"),
      [
        "import { readFile } from 'fs/promises';",
        "void readFile;",
        "document.body.dataset.ready = 'true';",
        "",
      ].join("\n")
    );
    git(panelDir, ["init", "-b", "main"]);
    git(panelDir, ["add", "."]);
    git(panelDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial panel",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-panels/fs-panel"),
      "ev-panel",
      graph,
      workspaceRoot,
      "state:test"
    );
    const primaryPath = result.artifacts.find((artifact) => artifact.role === "primary")?.path;
    const html = result.artifacts.find((artifact) => artifact.path === "index.html")?.content;

    expect(primaryPath).toMatch(/^bundle-[A-Za-z0-9]+\.js$/u);
    expect(html).toContain(
      `<script src="/__loader.js" data-bundle-src="./${primaryPath}"></script>`
    );
    expect(html).not.toContain('data-bundle-src="./bundle.js"');
    expect(html).not.toContain('src="./bundle.js"');
  });

  it("rejects dist as an app build target", async () => {
    const appDir = path.join(workspaceRoot, "apps", "prebuilt");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/prebuilt",
        version: "0.1.0",
        private: true,
        natstack: {
          app: {
            target: "dist",
            distDir: "dist",
          },
        },
      })
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial dist app",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    await expect(
      buildUnit(
        graph.get("@workspace-apps/prebuilt"),
        "ev-dist",
        graph,
        workspaceRoot,
        "state:test"
      )
    ).rejects.toThrow(/target must be "electron", "react-native", or "terminal"/);
  });
});

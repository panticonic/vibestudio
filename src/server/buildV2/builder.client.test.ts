import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUnit, type BuilderSession } from "./builder.js";
import { panelRuntimeHelperHref } from "../panelRuntimeHelpers.js";
import { createBuilderTestSession } from "./builderTestSession.js";
import { discoverPackageGraph } from "./packageGraph.js";
import { clearBuildProvidersForTests, registerBuildProvider } from "./buildProviderRegistry.js";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";

const SOURCE_STATE_HASH = `state:${"c".repeat(64)}`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function commitUnit(dir: string, message: string): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.name=Vibestudio Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}

describe("buildUnit client and panel bundle builds", () => {
  let root: string;
  let workspaceRoot: string;
  let session: BuilderSession;
  let closeSession: () => Promise<void>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-build-"));
    workspaceRoot = path.join(root, "workspace");
    const context = await createBuilderTestSession({
      appRoot: path.resolve(__dirname, "../../.."),
      workspaceRoot,
      stateRoot: path.join(root, "state"),
      runNativeJob: runIsolatedBuildJob,
    });
    session = context.session;
    closeSession = context.close;
    clearBuildProvidersForTests();
  });

  afterEach(async () => {
    await closeSession?.();
    clearBuildProvidersForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds a web client as one primary page that loads its own bundle", async () => {
    const clientDir = path.join(workspaceRoot, "clients", "desktop-browser");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/desktop-browser",
        version: "0.1.0",
        private: true,
        vibestudio: {
          authority: {
            provides: [],
            requests: [
              {
                capability: "app.getInfo",
                resource: { kind: "exact", key: "global" },
                tier: "gated",
                evidence: "exact",
              },
            ],
          },
          client: {
            id: "browser",
            runtime: "web",
            hostAbi: "web-host-1",
            entry: "index.ts",
            capabilities: { required: ["device-session"], optional: ["notifications"] },
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(clientDir, "index.ts"),
      "import './style.css'; document.body.dataset.ready = 'true';\n"
    );
    fs.writeFileSync(path.join(clientDir, "style.css"), "body { color: red; }\n");
    fs.writeFileSync(
      path.join(clientDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./bundle.css"></head><body><script type="module" src="./bundle.js"></script></body></html>'
    );
    commitUnit(clientDir, "initial client");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      session,
      graph.get("@workspace-clients/desktop-browser"),
      "a".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    const html = result.artifacts.find((artifact) => artifact.path === "index.html")?.content;

    expect(html).toMatch(/type="module" src="\.\/bundle-[A-Za-z0-9]+\.js"/u);
    expect(html).not.toContain('src="/__loader.js"');
    expect(html).not.toContain("<base ");
    expect(result.artifacts.filter((artifact) => artifact.role === "primary")).toEqual([
      expect.objectContaining({ path: "index.html", contentType: "text/html; charset=utf-8" }),
    ]);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/^bundle-[A-Za-z0-9]+\.js$/u),
          role: "asset",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/^bundle-[A-Za-z0-9]+\.css$/u),
          role: "css",
        }),
      ])
    );
    for (const artifact of result.artifacts) {
      expect(artifact.integrity).toMatch(/^sha256-[0-9a-f]{64}$/u);
    }
    expect(result.artifacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "map" })])
    );
    const bundle = result.artifacts.find((artifact) => artifact.path.endsWith(".js"));
    expect(bundle?.content).not.toContain("sourceMappingURL=");
    expect(result.buildKey).toBe(result.metadata.buildKey);
    expect(result.metadata.details).toEqual({
      kind: "client",
      clientId: "browser",
      runtime: "web",
      hostAbi: "web-host-1",
      provider: null,
    });
    expect(result.metadata.bundleReport).toBeUndefined();
    expect(result.metadata.authority).toEqual({
      provides: [],
      serviceRequests: [],
      requests: [
        {
          capability: "app.getInfo",
          resource: { kind: "exact", key: "global" },
          tier: "gated",
          evidence: "exact",
        },
      ],
    });
  });

  it("fails a web client build whose declared entry does not exist", async () => {
    const clientDir = path.join(workspaceRoot, "clients", "no-entry");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/no-entry",
        version: "0.1.0",
        private: true,
        vibestudio: {
          client: { id: "no-entry", runtime: "web", hostAbi: "web-host-1", entry: "missing.tsx" },
        },
      })
    );
    commitUnit(clientDir, "initial client without entry");

    const graph = discoverPackageGraph(workspaceRoot);
    await expect(
      buildUnit(
        session,
        graph.get("@workspace-clients/no-entry"),
        "d".repeat(64),
        graph,
        workspaceRoot,
        SOURCE_STATE_HASH
      )
    ).rejects.toThrow(/Client @workspace-clients\/no-entry entry does not exist: missing\.tsx/u);
  });

  it("builds browser-viewable document and media assets with inline content types", async () => {
    const appDir = path.join(workspaceRoot, "clients", "asset-viewer");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/asset-viewer",
        version: "0.1.0",
        private: true,
        vibestudio: {
          client: { id: "asset-viewer", runtime: "web", hostAbi: "web-host-1", entry: "index.ts" },
        },
      })
    );
    const assets = [
      ["guide.pdf", "%PDF-1.7\n"],
      ["track.m4a", "m4a-bytes"],
      ["movie.webm", "webm-bytes"],
      ["photo.avif", "avif-bytes"],
    ] as const;
    for (const [fileName, content] of assets) {
      fs.writeFileSync(path.join(appDir, fileName), Buffer.from(content));
    }
    fs.writeFileSync(
      path.join(appDir, "index.ts"),
      `${assets.map(([fileName], index) => `import asset${index} from "./${fileName}";`).join("\n")}\ndocument.body.dataset.assets = [${assets.map((_, index) => `asset${index}`).join(", ")}].join(",");\n`
    );
    fs.writeFileSync(
      path.join(appDir, "index.html"),
      '<!doctype html><html><body><script type="module" src="./bundle.js"></script></body></html>'
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial asset viewer client",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      session,
      graph.get("@workspace-clients/asset-viewer"),
      "b".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );

    expect(
      Object.fromEntries(
        assets.map(([fileName]) => {
          const extension = path.extname(fileName);
          const stem = path.basename(fileName, extension);
          const artifact = result.artifacts.find(
            (entry) => entry.path.includes(`/${stem}-`) && entry.path.endsWith(extension)
          );
          return [fileName, artifact?.contentType];
        })
      )
    ).toEqual({
      "guide.pdf": "application/pdf",
      "track.m4a": "audio/mp4",
      "movie.webm": "video/webm",
      "photo.avif": "image/avif",
    });
  });

  it("bundles a terminal client as one self-contained ESM program", async () => {
    const rpcDir = path.join(workspaceRoot, "packages", "rpc");
    fs.mkdirSync(path.join(rpcDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(rpcDir, "package.json"),
      JSON.stringify({
        name: "@vibestudio/rpc",
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
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial rpc package",
    ]);
    const appDir = path.join(workspaceRoot, "clients", "terminal-browser");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/terminal-browser",
        version: "0.1.0",
        private: true,
        vibestudio: {
          client: {
            id: "browser",
            runtime: "terminal",
            hostAbi: "terminal-host-1",
            entry: "index.ts",
            capabilities: { optional: ["clipboard"] },
          },
        },
        dependencies: {
          "@vibestudio/rpc": "workspace:*",
          ws: "^8.18.3",
        },
      })
    );
    fs.writeFileSync(
      path.join(appDir, "index.ts"),
      [
        "import { createHandlerRegistry } from '@vibestudio/rpc';",
        "import WebSocket from 'ws';",
        "export function main() {",
        "  const registry = createHandlerRegistry();",
        "  return { label: 'terminal-browser', hasWs: typeof WebSocket === 'function', registry };",
        "}",
        "",
      ].join("\n")
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial terminal client",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      session,
      graph.get("@workspace-clients/terminal-browser"),
      "b".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );

    expect(result.metadata.details).toEqual({
      kind: "client",
      clientId: "browser",
      runtime: "terminal",
      hostAbi: "terminal-host-1",
      provider: null,
    });
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: "index.mjs",
        role: "primary",
        integrity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
      }),
    ]);
    const mod = (await import(pathToFileURL(path.join(result.dir, "index.mjs")).href)) as {
      main: () => { hasWs: boolean };
    };
    expect(mod.main()).toMatchObject({ hasWs: true });
  });

  it("activates a dormant provider before building a React Native client", async () => {
    let providerInput: BuildProviderInput | null = null;
    let providerBuilds = 0;
    let providerEv = "ev-provider";
    let corruptStream = false;
    let projectedPlatformSource = "";
    const testNodeModules = path.join(root, "node_modules");
    const platformPackage = path.join(testNodeModules, "@platform", "fake");
    fs.mkdirSync(path.join(platformPackage, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(platformPackage, "package.json"),
      JSON.stringify({ name: "@platform/fake", version: "0.1.0", type: "module" })
    );
    fs.writeFileSync(path.join(platformPackage, "src", "index.ts"), "export const fake = true;\n");
    const appDir = path.join(workspaceRoot, "clients", "mobile-browser");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/mobile-browser",
        version: "0.1.0",
        private: true,
        dependencies: { "@platform/fake": "workspace:*" },
        vibestudio: {
          client: {
            id: "browser",
            runtime: "react-native",
            hostAbi: "rn-host-6",
            entry: "App.tsx",
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(appDir, "App.tsx"),
      "export default function App() { return null; }\n"
    );
    git(appDir, ["init", "-b", "main"]);
    git(appDir, ["add", "."]);
    git(appDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial app",
    ]);

    let demandedTarget: string | undefined;
    await closeSession();
    const providerContext = await createBuilderTestSession({
      appRoot: path.resolve(__dirname, "../../.."),
      workspaceRoot,
      stateRoot: path.join(root, "state"),
      appNodeModules: testNodeModules,
      runNativeJob: runIsolatedBuildJob,
      ensureBuildProvider: async (target) => {
        demandedTarget = target;
        registerBuildProvider({
          name: "@workspace-extensions/react-native-provider",
          target: "react-native",
          contractVersion: "1",
          activeEv: providerEv,
          activeBuildKey: "provider-build",
          build: async (input) => {
            providerBuilds++;
            providerInput = input;
            expect(fs.readFileSync(path.join(input.sourcePath, "App.tsx"), "utf8")).toContain(
              "function App"
            );
            projectedPlatformSource = fs.readFileSync(
              path.join(input.dependencyProjection.modules["@platform/fake"]!, "src", "index.ts"),
              "utf8"
            );
            return {
              artifacts: [
                {
                  path: "ios/main.hbc",
                  role: "primary",
                  contentType: "application/octet-stream",
                  encoding: "base64",
                  platform: "ios",
                  stream: {
                    method: "buildArtifact",
                    args: ["ios-main"],
                    integrity: `sha256-${createHash("sha256").update(`bundle:${input.unitName}:${input.effectiveVersion}`).digest("hex")}`,
                  },
                },
              ],
            };
          },
          streamArtifact: async (_artifact, input) => {
            // Provider inputs remain admitted until every lazy artifact is consumed.
            expect(fs.existsSync(path.join(input.sourcePath, "App.tsx"))).toBe(true);
            return new Response(
              corruptStream
                ? "corrupt bundle"
                : `bundle:${input.unitName}:${input.effectiveVersion}`
            );
          },
        });
      },
    });
    session = providerContext.session;
    closeSession = providerContext.close;

    const graph = discoverPackageGraph(workspaceRoot);
    let result: Awaited<ReturnType<typeof buildUnit>>;
    result = await buildUnit(
      session,
      graph.get("@workspace-clients/mobile-browser"),
      "c".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    const repeats = await Promise.all(
      Array.from({ length: 3 }, () =>
        buildUnit(
          session,
          graph.get("@workspace-clients/mobile-browser"),
          "c".repeat(64),
          graph,
          workspaceRoot,
          SOURCE_STATE_HASH
        )
      )
    );
    expect(repeats.map((build) => build.buildKey)).toEqual(Array(3).fill(result.buildKey));
    expect(providerBuilds).toBe(1);

    providerEv = "ev-provider-2";
    const changedProvider = await buildUnit(
      session,
      graph.get("@workspace-clients/mobile-browser"),
      "c".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    expect(changedProvider.buildKey).not.toBe(result.buildKey);
    expect(providerBuilds).toBe(2);

    expect(demandedTarget).toBe("react-native");

    expect(result.metadata).toMatchObject({
      kind: "client",
      name: "@workspace-clients/mobile-browser",
      sourceStateHash: SOURCE_STATE_HASH,
      details: {
        kind: "client",
        clientId: "browser",
        runtime: "react-native",
        hostAbi: "rn-host-6",
        provider: {
          name: "@workspace-extensions/react-native-provider",
          activeEv: "ev-provider",
          activeBuildKey: "provider-build",
          contractVersion: "1",
        },
      },
    });
    expect(result.sourceStateHash).toBe(SOURCE_STATE_HASH);
    expect(providerInput).toMatchObject({
      client: { id: "browser", runtime: "react-native", hostAbi: "rn-host-6", entry: "App.tsx" },
      sourcePath: expect.stringContaining(path.join(root, "state", "build-provider-inputs")),
      dependencyProjection: {
        nodeModulesPath: null,
        modules: {
          "@platform/fake": expect.stringContaining(
            path.join(root, "state", "build-provider-inputs")
          ),
          "@workspace-clients/mobile-browser": providerInput!.sourcePath,
        },
      },
    });
    expect(fs.existsSync(providerInput!.sourcePath)).toBe(false);
    expect(projectedPlatformSource).toBe("export const fake = true;\n");
    expect(providerInput!.dependencyProjection.modules["@platform/fake"]).not.toBe(platformPackage);
    expect(providerInput).not.toHaveProperty("workspaceRoot");
    expect(providerInput).not.toHaveProperty("sourceRoot");
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: "ios/main.hbc",
        role: "primary",
        encoding: "base64",
        platform: "ios",
        integrity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
        content: Buffer.from(`bundle:@workspace-clients/mobile-browser:${"c".repeat(64)}`).toString(
          "base64"
        ),
      }),
    ]);
    corruptStream = true;
    providerEv = "ev-provider-corrupt-stream";
    await expect(
      buildUnit(
        session,
        graph.get("@workspace-clients/mobile-browser"),
        "c".repeat(64),
        graph,
        workspaceRoot,
        SOURCE_STATE_HASH
      )
    ).rejects.toThrow(/streamed artifact ios\/main\.hbc with integrity .* expected/);
  });

  describe("client artifact contract at build time", () => {
    function commitReactNativeClient(): void {
      const appDir = path.join(workspaceRoot, "clients", "mobile-browser");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "package.json"),
        JSON.stringify({
          name: "@workspace-clients/mobile-browser",
          version: "0.1.0",
          private: true,
          vibestudio: {
            client: {
              id: "browser",
              runtime: "react-native",
              hostAbi: "rn-host-6",
              entry: "App.tsx",
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(appDir, "App.tsx"),
        "export default function App() { return null; }\n"
      );
      git(appDir, ["init", "-b", "main"]);
      git(appDir, ["add", "."]);
      git(appDir, [
        "-c",
        "user.name=Vibestudio Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "initial app",
      ]);
    }

    async function buildMobileWith(
      ensureBuildProvider: (target: "react-native") => Promise<void>
    ): Promise<unknown> {
      commitReactNativeClient();
      await closeSession();
      const context = await createBuilderTestSession({
        appRoot: path.resolve(__dirname, "../../.."),
        workspaceRoot,
        stateRoot: path.join(root, "state"),
        runNativeJob: runIsolatedBuildJob,
        ensureBuildProvider,
      });
      session = context.session;
      closeSession = context.close;
      const graph = discoverPackageGraph(workspaceRoot);
      return buildUnit(
        session,
        graph.get("@workspace-clients/mobile-browser"),
        "d".repeat(64),
        graph,
        workspaceRoot,
        SOURCE_STATE_HASH
      );
    }

    function registerProviderReturning(output: {
      artifacts: Array<{ platform?: "ios" | "android"; path: string }>;
    }) {
      return async () => {
        registerBuildProvider({
          name: "@workspace-extensions/react-native-provider",
          target: "react-native",
          contractVersion: "1",
          activeEv: "ev-provider",
          activeBuildKey: "provider-build",
          build: async () => ({
            artifacts: output.artifacts.map((artifact) => ({
              ...artifact,
              role: "primary" as const,
              contentType: "application/octet-stream",
              content: "bundle",
            })),
          }),
        });
      };
    }

    it("rejects a React Native build with two primary artifacts for one platform", async () => {
      await expect(
        buildMobileWith(
          registerProviderReturning({
            artifacts: [
              { path: "ios/a.hbc", platform: "ios" },
              { path: "ios/b.hbc", platform: "ios" },
            ],
          })
        )
      ).rejects.toThrow(/more than one primary bundle for ios/u);
      // The rejected artifact stays in the store; a repeat must not slip through the cache.
      const graph = discoverPackageGraph(workspaceRoot);
      await expect(
        buildUnit(
          session,
          graph.get("@workspace-clients/mobile-browser"),
          "d".repeat(64),
          graph,
          workspaceRoot,
          SOURCE_STATE_HASH
        )
      ).rejects.toThrow(/more than one primary bundle for ios/u);
    });

    it("rejects a React Native build whose primary artifact has no platform", async () => {
      await expect(
        buildMobileWith(
          registerProviderReturning({
            artifacts: [{ path: "main.hbc" }],
          })
        )
      ).rejects.toThrow(/primary artifact main\.hbc has no mobile platform/u);
    });

    it("fails clearly when the React Native build provider is unavailable", async () => {
      await expect(
        buildMobileWith(async () => {
          throw new Error("Required build extension is unavailable: extensions/rn-provider");
        })
      ).rejects.toThrow(
        /React Native client @workspace-clients\/mobile-browser cannot be built because its build provider is unavailable: Required build extension is unavailable/u
      );
    });
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
      "user.name=Vibestudio Test",
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
        vibestudio: {
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
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial panel",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      session,
      graph.get("@workspace-panels/fs-panel"),
      "d".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    const primaryPath = result.artifacts.find((artifact) => artifact.role === "primary")?.path;
    const html = result.artifacts.find((artifact) => artifact.path === "index.html")?.content;

    expect(primaryPath).toMatch(/^bundle-[A-Za-z0-9]+\.js$/u);
    expect(html).toContain(
      `<script src="${panelRuntimeHelperHref("__loader.js")}" data-bundle-src="./${primaryPath}"></script>`
    );
    expect(html).not.toContain('data-bundle-src="./bundle.js"');
    expect(html).not.toContain('src="./bundle.js"');
  });

  it("keeps exposed namespace barrels outside the panel startup graph", async () => {
    const heavyDir = path.join(workspaceRoot, "packages", "heavy");
    fs.mkdirSync(heavyDir, { recursive: true });
    fs.writeFileSync(
      path.join(heavyDir, "package.json"),
      JSON.stringify({
        name: "@workspace/heavy",
        version: "0.1.0",
        type: "module",
        exports: { ".": "./index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(heavyDir, "index.ts"),
      `export const payload = ${JSON.stringify("heavy payload ".repeat(2048))};\n`
    );
    git(heavyDir, ["init", "-b", "main"]);
    git(heavyDir, ["add", "."]);
    git(heavyDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial heavy package",
    ]);

    const panelDir = path.join(workspaceRoot, "panels", "lazy-expose");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/lazy-expose",
        version: "0.1.0",
        type: "module",
        vibestudio: {
          entry: "index.ts",
          exposeModules: ["@workspace/heavy"],
        },
        dependencies: { "@workspace/heavy": "workspace:*" },
      })
    );
    fs.writeFileSync(path.join(panelDir, "index.ts"), "document.body.dataset.ready = 'true';\n");
    git(panelDir, ["init", "-b", "main"]);
    git(panelDir, ["add", "."]);
    git(panelDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial lazy expose panel",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      session,
      graph.get("@workspace-panels/lazy-expose"),
      "f".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    const primary = result.artifacts.find((artifact) => artifact.role === "primary");
    const lazyArtifacts = result.artifacts.filter(
      (artifact) => artifact.role === "asset" && artifact.path.endsWith(".js")
    );

    expect(primary?.content).not.toContain("heavy payload");
    expect(lazyArtifacts.some((artifact) => artifact.content.includes("heavy payload"))).toBe(true);
    expect(result.metadata.bundleReport?.lazy.bytes).toBeGreaterThan(0);
  });

  it("rejects a client whose runtime is not one of the supported runtimes", async () => {
    const clientDir = path.join(workspaceRoot, "clients", "prebuilt");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, "package.json"),
      JSON.stringify({
        name: "@workspace-clients/prebuilt",
        version: "0.1.0",
        private: true,
        vibestudio: {
          client: { id: "prebuilt", runtime: "dist", hostAbi: "dist-host-1", entry: "index.html" },
        },
      })
    );
    commitUnit(clientDir, "initial dist client");

    const graph = discoverPackageGraph(workspaceRoot);
    await expect(
      buildUnit(
        session,
        graph.get("@workspace-clients/prebuilt"),
        "e".repeat(64),
        graph,
        workspaceRoot,
        SOURCE_STATE_HASH
      )
    ).rejects.toThrow(/runtime must be one of web, react-native, terminal/);
  });
});

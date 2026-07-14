import { describe, expect, it } from "vitest";
import {
  parseWorkspaceConfigContentWithId,
  resolveHostTargetDecl,
  resolveHostTargetRequiredExtensions,
  workspaceAppPackageName,
  workspaceExtensionPackageName,
  workspaceProviderExtensionPackageName,
} from "./configParser.js";

const parse = (yaml: string) => parseWorkspaceConfigContentWithId(yaml, "test-ws");

const FULL_MANIFEST = `
singletonObjects:
  - source: workers/gad-store
    className: GadWorkspaceDO
    key: workspace-gad
extensions:
  - source: extensions/browser-data
  - source: extensions/git-bridge
  - source: extensions/claude-code
apps:
  - source: apps/shell
providers:
  evalEngine:
    source: "@workspace/eval"
  evalRuntime:
    source: "@workspace/runtime"
  cdpClient:
    source: "@workspace/cdp-client"
  browserData:
    extension: extensions/browser-data
  gitInterop:
    extension: extensions/git-bridge
  claudeCode:
    extension: extensions/claude-code
hostTargets:
  electron:
    app: apps/shell
  react-native:
    app: "@workspace-apps/mobile"
    requiresExtensions:
      - extensions/react-native
  terminal:
    app: apps/remote-cli
`;

describe("manifest declarations: initial panels", () => {
  it("preserves a string environment alongside state arguments", () => {
    expect(
      parse(`
initPanels:
  - source: panels/spectrolite
    env:
      VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS: "1"
    stateArgs:
      openPath: E2E.mdx
`).initPanels
    ).toEqual([
      {
        source: "panels/spectrolite",
        env: { VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS: "1" },
        stateArgs: { openPath: "E2E.mdx" },
      },
    ]);
  });

  it("rejects non-string panel environment values", () => {
    expect(() =>
      parse("initPanels:\n  - source: panels/chat\n    env:\n      DEBUG: true\n")
    ).toThrow(/initPanels\.0\.env\.DEBUG/);
  });
});

describe("manifest declarations: providers / hostTargets", () => {
  it("parses a full declaration set", () => {
    const config = parse(FULL_MANIFEST);
    expect(config.providers?.evalEngine?.source).toBe("@workspace/eval");
    expect(config.providers?.cdpClient?.source).toBe("@workspace/cdp-client");
  });

  it("resolves host target declarations (canonical forms + requires)", () => {
    const config = parse(FULL_MANIFEST);
    expect(resolveHostTargetDecl(config, "electron")).toEqual({
      appSource: "apps/shell",
      requiresExtensions: [],
    });
    expect(resolveHostTargetDecl(config, "react-native")).toEqual({
      appSource: "apps/mobile",
      requiresExtensions: ["extensions/react-native"],
    });
    expect(resolveHostTargetDecl(parse("initPanels: []\n"), "electron")).toBeNull();
    expect(resolveHostTargetRequiredExtensions(config)).toEqual([
      { source: "extensions/react-native", ref: "main" },
    ]);
    expect(resolveHostTargetRequiredExtensions(config, "electron")).toEqual([]);
    expect(resolveHostTargetRequiredExtensions(config, "react-native")).toEqual([
      { source: "extensions/react-native", ref: "main" },
    ]);
  });

  it("resolves the browser-data provider package name (null when undeclared)", () => {
    expect(workspaceProviderExtensionPackageName(parse(FULL_MANIFEST), "browserData")).toBe(
      "@workspace-extensions/browser-data"
    );
    expect(
      workspaceProviderExtensionPackageName(parse("initPanels: []\n"), "browserData")
    ).toBeNull();
  });

  it("resolves extension provider package names from provider slots", () => {
    const config = parse(FULL_MANIFEST);
    expect(workspaceProviderExtensionPackageName(config, "gitInterop")).toBe(
      "@workspace-extensions/git-bridge"
    );
    expect(workspaceProviderExtensionPackageName(config, "claudeCode")).toBe(
      "@workspace-extensions/claude-code"
    );
    expect(workspaceProviderExtensionPackageName(config, "missing")).toBeNull();
  });

  it("rejects the removed process-global trust declaration", () => {
    expect(() => parse("trust:\n  chromeApps:\n    - apps/shell\n")).toThrow(/unknown.*trust/i);
  });

  it("rejects unknown host targets and malformed app declarations", () => {
    expect(() => parse("hostTargets:\n  browser:\n    app: apps/shell\n")).toThrow(
      /unknown `hostTargets` key/
    );
    expect(() => parse("hostTargets:\n  electron:\n    app: extensions/shell\n")).toThrow(
      /hostTargets\.electron\.app/
    );
  });

  it("rejects provider slots without a source", () => {
    expect(() => parse("providers:\n  evalEngine: {}\n")).toThrow(/providers\.evalEngine\.source/);
    expect(() => parse('providers:\n  evalRuntime:\n    source: ""\n')).toThrow(
      /providers\.evalRuntime\.source/
    );
  });

  it("rejects an extension provider that is not a declared extension", () => {
    expect(() =>
      parse("providers:\n  browserData:\n    extension: extensions/browser-data\n")
    ).toThrow(/must also be declared under `extensions`/);
    expect(() =>
      parse("providers:\n  gitInterop:\n    extension: extensions/git-bridge\n")
    ).toThrow(/must also be declared under `extensions`/);
  });
});

describe("manifest declarations: canonical Git config", () => {
  it("accepts object-only remote and upstream declarations", () => {
    const config = parse(`
git:
  remotes:
    projects:
      demo:
        origin:
          url: https://github.com/acme/demo.git
          branch: main
  upstreams:
    projects:
      demo:
        remote: origin
        branch: main
        autoPush: false
`);

    expect(config.git?.remotes?.["projects"]?.["demo"]?.["origin"]).toEqual({
      url: "https://github.com/acme/demo.git",
      branch: "main",
    });
  });

  it.each([
    [
      "string remote shorthand",
      `git:\n  remotes:\n    projects:\n      demo:\n        origin: https://github.com/acme/demo.git\n`,
    ],
    [
      "nullable remote branch",
      `git:\n  remotes:\n    projects:\n      demo:\n        origin:\n          url: https://github.com/acme/demo.git\n          branch: null\n`,
    ],
    ["remote tombstone", `git:\n  remotes:\n    projects:\n      demo:\n        origin: null\n`],
    ["upstream tombstone", `git:\n  upstreams:\n    projects:\n      demo: null\n`],
  ])("rejects %s", (_label, yaml) => {
    expect(() => parse(yaml)).toThrow(/meta\/vibestudio\.yml/);
  });
});

describe("workspace package-name helpers (centralized scopes)", () => {
  it("maps both identity forms to scoped package names", () => {
    expect(workspaceAppPackageName("apps/shell")).toBe("@workspace-apps/shell");
    expect(workspaceAppPackageName("@workspace-apps/shell")).toBe("@workspace-apps/shell");
    expect(workspaceExtensionPackageName("extensions/browser-data")).toBe(
      "@workspace-extensions/browser-data"
    );
    expect(workspaceExtensionPackageName("@workspace-extensions/browser-data")).toBe(
      "@workspace-extensions/browser-data"
    );
  });

  it("rejects non-unit-shaped identities", () => {
    expect(() => workspaceAppPackageName("panels/chat")).toThrow();
    expect(() => workspaceExtensionPackageName("apps/shell")).toThrow();
  });
});

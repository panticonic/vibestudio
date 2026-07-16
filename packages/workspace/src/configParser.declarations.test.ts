import { describe, expect, it } from "vitest";
import {
  parseWorkspaceConfigContentWithId,
  resolveHostTargetDecl,
  resolveHostTargetRequiredExtensions,
  resolveWorkspaceTrustGrants,
  workspaceAppPackageName,
  workspaceExtensionPackageName,
  workspaceProviderExtensionPackageName,
} from "./configParser.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const parse = (yaml: string) =>
  parseWorkspaceConfigContentWithId(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n${yaml}`, "test-ws");

const FULL_MANIFEST = `
singletonObjects:
  - source: workers/agent-worker
    className: AgentWorkspaceDO
    key: workspace-agent
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
trust:
  chromeApps:
    - apps/shell
    - "@workspace-apps/mobile"
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

describe("manifest declarations: providers / trust / hostTargets", () => {
  it("rejects a missing or mismatched pre-release workspace system epoch", () => {
    expect(() => parseWorkspaceConfigContentWithId("initPanels: []\n", "test-ws")).toThrow(
      /systemEpoch.*Required/
    );
    expect(() =>
      parseWorkspaceConfigContentWithId(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH - 1}\ninitPanels: []\n`,
        "test-ws"
      )
    ).toThrow(/incompatible with host epoch/);
  });

  it("parses a full declaration set", () => {
    const config = parse(FULL_MANIFEST);
    expect(config.providers?.evalEngine?.source).toBe("@workspace/eval");
    expect(config.providers?.cdpClient?.source).toBe("@workspace/cdp-client");
    expect(config.trust?.chromeApps).toHaveLength(2);
  });

  it("resolves trust grants to canonical repo paths (both identity forms)", () => {
    const grants = resolveWorkspaceTrustGrants(parse(FULL_MANIFEST));
    expect(grants.chromeApps).toEqual(["apps/shell", "apps/mobile"]);
  });

  it("resolves empty grants when trust is absent — trust is never assumed", () => {
    const grants = resolveWorkspaceTrustGrants(parse("initPanels: []\n"));
    expect(grants.chromeApps).toEqual([]);
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

  it("rejects malformed trust lists", () => {
    expect(() => parse("trust:\n  chromeApps: apps/shell\n")).toThrow(/must be a list/);
    expect(() => parse("trust:\n  chromeApps:\n    - panels/chat\n")).toThrow(/trust\.chromeApps/);
    expect(() =>
      parse('trust:\n  chromeApps:\n    - apps/shell\n    - "@workspace-apps/shell"\n')
    ).toThrow(/duplicate/);
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

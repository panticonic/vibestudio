import { describe, expect, it } from "vitest";
import {
  parseWorkspaceConfigContentWithId,
  parseWorkspaceSystemEpochEnvelope,
  readWorkspaceConfig,
  resolveExtensionsForHostTargets,
  resolveHostTargetDecl,
  resolveHostTargetRequiredExtensions,
  resolveWorkspaceTrustGrants,
  workspaceAppPackageName,
  workspaceExtensionPackageName,
  workspaceProviderExtensionPackageName,
} from "./configParser.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const parse = (yaml: string, manifests: Record<string, string> = {}) =>
  parseWorkspaceConfigContentWithId(
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n${yaml}`,
    "test-ws",
    (source) => manifests[source] ?? null
  );

describe("template authoring metadata", () => {
  it.each([
    ["scalar", "template: invalid\n"],
    ["unknown key", "template:\n  mystery: true\n"],
    ["removed inventory", "template:\n  repositories: []\n"],
    [
      "duplicate override",
      "template:\n  overrides:\n    - { repoPath: panels/example, source: https://example.test/base.git }\n    - { repoPath: panels/example, source: https://example.test/base.git }\n",
    ],
  ])("rejects invalid metadata: %s", (_label, template) => {
    expect(() => parse(template)).toThrow(/meta\/vibestudio\.yml: .*`template/);
  });

  it("reports runtime errors at their runtime path when metadata is present", () => {
    const source = "template: {}\nproviders:\n  evalEngine: {}\n";
    expect(() => parse(source)).toThrow(/`providers\.evalEngine\.source`/);
    expect(() => parse(source)).not.toThrow(/`template\.providers/);
  });

  it("validates and removes authoring metadata from runtime configuration", () => {
    expect(parse("template:\n  name: Example\n")).not.toHaveProperty("template");
  });
});

describe("workspace epoch envelope", () => {
  it("reads a foreign epoch without interpreting future manifest fields", () => {
    expect(
      parseWorkspaceSystemEpochEnvelope("systemEpoch: 99\nfutureShape:\n  unknowable: true\n")
    ).toBe(99);
    expect(() => parseWorkspaceSystemEpochEnvelope("systemEpoch: -1\n")).toThrow(
      /nonnegative integer/u
    );
  });
});

const FULL_MANIFEST = `
singletonObjects:
  - source: workers/agent-worker
    className: AgentWorkspaceDO
    key: workspace-agent
extensions:
  - source: extensions/browser-data
  - source: extensions/git-bridge
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
  it("reads exactly one flattened runtime manifest", async () => {
    const reads: string[] = [];
    await expect(
      readWorkspaceConfig(
        {
          readText: async (path) => {
            reads.push(path);
            return `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/chat\n`;
          },
        },
        "test-ws"
      )
    ).resolves.toMatchObject({ id: "test-ws", defaultRepo: "panels/chat" });
    expect(reads).toEqual(["meta/vibestudio.yml"]);
  });

  it("rejects userland composition fields in the runtime manifest", () => {
    expect(() =>
      parseWorkspaceConfigContentWithId(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplates:\n  use: []\n`,
        "test-ws"
      )
    ).toThrow(/unknown .*templates/u);
    expect(() =>
      parseWorkspaceConfigContentWithId(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndisable:\n  - apps\/apps\/chat\n`,
        "test-ws"
      )
    ).toThrow(/unknown .*disable/u);
  });

  it("rejects a persisted workspace id", () => {
    expect(() =>
      parseWorkspaceConfigContentWithId(
        `id: checkout-name\nsystemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`,
        "test-ws"
      )
    ).toThrow("`id` is resolved by the host");
  });

  it("rejects a missing or mismatched workspace runtime ABI epoch", () => {
    expect(() => parseWorkspaceConfigContentWithId("initPanels: []\n", "test-ws")).toThrow(
      /systemEpoch.*Required/
    );
    expect(() =>
      parseWorkspaceConfigContentWithId(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH + 1}\ninitPanels: []\n`,
        "test-ws"
      )
    ).toThrow(/requires workspace host epoch/);
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
    expect(resolveExtensionsForHostTargets(config, ["electron"])).toEqual([
      { source: "extensions/browser-data", ref: "main" },
      { source: "extensions/git-bridge", ref: "main" },
    ]);
    expect(resolveExtensionsForHostTargets(config, ["react-native"])).toEqual([
      { source: "extensions/react-native", ref: "main" },
      { source: "extensions/browser-data", ref: "main" },
      { source: "extensions/git-bridge", ref: "main" },
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

describe("manifest declarations: product workspace services", () => {
  it("accepts user-facing service approval copy", () => {
    expect(
      parse("services:\n  - source: workers/notes\n    name: notes\n", {
        "workers/notes": JSON.stringify({
          vibestudio: {
            services: [
              {
                name: "notes",
                title: "Notes",
                action: "read and update your notes",
                description: "Reads and updates notes stored in this workspace.",
                presentation: { domain: "automation", verb: "act" },
                authority: { principals: ["code"] },
                durableObject: { className: "NotesDO" },
              },
            ],
          },
        }),
      })
    ).toMatchObject({
      services: [
        {
          name: "notes",
          title: "Notes",
          action: "read and update your notes",
        },
      ],
    });
  });

  it("accepts a declared service binding whose methods own their authority", () => {
    expect(
      parse("services:\n  - source: workers/workspace-source\n    name: gad.workspace\n", {
        "workers/workspace-source": JSON.stringify({
          vibestudio: {
            services: [
              {
                name: "gad.workspace",
                title: "Workspace data",
                action: "use this workspace's files and history",
                presentation: { domain: "automation", verb: "manage" },
                authority: { binding: "declared", principals: ["code"] },
                durableObject: { className: "GadWorkspaceDO" },
              },
            ],
          },
        }),
      })
    ).toMatchObject({
      services: [{ name: "gad.workspace", authority: { binding: "declared" } }],
    });
  });

  it("accepts declared wiring restricted to named consumer units", () => {
    expect(
      parse("services:\n  - source: workers/flowboard-store\n    name: flowboard-store\n", {
        "workers/flowboard-store": JSON.stringify({
          vibestudio: {
            services: [
              {
                name: "flowboard-store",
                action: "manage Flowboard lists and tasks",
                presentation: { domain: "automation", verb: "act" },
                authority: { binding: { declaredFor: ["panels/flowboard"] }, principals: ["code"] },
                durableObject: { className: "FlowboardStore" },
              },
            ],
          },
        }),
      })
    ).toMatchObject({
      services: [
        {
          name: "flowboard-store",
          authority: { binding: { declaredFor: ["panels/flowboard"] } },
        },
      ],
    });
  });

  it("accepts the workspace source provider as an ordinary manifest service", () => {
    expect(
      parse("services:\n  - source: workers/impostor\n    name: gad.workspace\n", {
        "workers/impostor": JSON.stringify({
          vibestudio: {
            services: [
              {
                name: "gad.workspace",
                action: "impersonate the workspace service",
                presentation: { domain: "automation", verb: "act" },
                authority: { principals: ["code"] },
                durableObject: { className: "ImpostorDO" },
              },
            ],
          },
        }),
      })
    ).toMatchObject({ services: [{ name: "gad.workspace" }] });
  });

  it("accepts the workspace source protocol from its repository export", () => {
    expect(
      parse("services:\n  - source: workers/impostor\n    name: impostor\n", {
        "workers/impostor": JSON.stringify({
          vibestudio: {
            services: [
              {
                name: "impostor",
                action: "impersonate the workspace protocol",
                presentation: { domain: "automation", verb: "act" },
                protocols: ["vibestudio.gad.workspace.v1"],
                authority: { principals: ["code"] },
                durableObject: { className: "ImpostorDO" },
              },
            ],
          },
        }),
      })
    ).toMatchObject({
      services: [{ protocols: ["vibestudio.gad.workspace.v1"] }],
    });
  });
});

it("rejects Git service settings in authored workspace configuration", () => {
  expect(() => parse("git: { remotes: {}, upstreams: {} }\n")).toThrow(/unknown.*git/);
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

it("reads the composed compatibility floor through the future-schema envelope", async () => {
  const { parseWorkspaceAppCompatibilityEnvelope } = await import("./configParser");
  const { appCompatibilityError } =
    await import("@vibestudio/workspace-contracts/appCompatibility");
  const requirement = parseWorkspaceAppCompatibilityEnvelope(
    JSON.stringify({
      systemEpoch: 1,
      minimumAppVersion: "1.5.0",
      futureRuntimeField: { unsupported: true },
    })
  );
  expect(requirement).toEqual({ systemEpoch: 1, minimumAppVersion: "1.5.0" });
  expect(appCompatibilityError(requirement, "1.0.0")).toContain("1.5.0");
  expect(appCompatibilityError(requirement, "1.6.0")).toBeNull();
});

it("resolves selected service exports from the same exact tree as workspace wiring", async () => {
  const calls: string[] = [];
  const content = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\nservices:\n  - { source: workers/notes, name: notes }\n`;
  const exported = {
    name: "notes",
    action: "read notes",
    description: "The selected revision",
    presentation: { domain: "files", verb: "see" },
    protocols: ["notes.v1"],
    authority: { principals: ["code"] },
    durableObject: { className: "NotesDO" },
  };
  const reader = {
    readText: async (filePath: string) => {
      calls.push(filePath);
      return filePath === "meta/vibestudio.yml"
        ? content
        : filePath === "workers/notes/package.json"
          ? JSON.stringify({ vibestudio: { services: [exported] } })
          : null;
    },
  };
  expect((await readWorkspaceConfig(reader, "workspace")).services).toEqual([
    { ...exported, source: "workers/notes" },
  ]);
  expect(calls).toEqual(["meta/vibestudio.yml", "workers/notes/package.json"]);
  await expect(
    readWorkspaceConfig(
      { readText: async (filePath) => (filePath === "meta/vibestudio.yml" ? content : null) },
      "workspace"
    )
  ).rejects.toThrow("requires workers/notes/package.json");
  expect(() =>
    parse("services:\n  - { source: workers/notes, name: notes, action: obsolete }\n")
  ).toThrow(/unknown.*action/);
});

it("rejects singleton runtime identity in workspace source", () => {
  expect(() =>
    parse(
      "singletonObjects:\n  - { source: workers/notes, className: NotesDO, key: notes, contextId: local-context }\n"
    )
  ).toThrow(/unknown.*contextId/);
});

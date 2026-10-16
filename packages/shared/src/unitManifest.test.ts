import { describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITY_CATALOG,
  HOST_KINDS,
  HOST_RUNTIME,
  capabilitiesForRuntime,
} from "@vibestudio/workspace-contracts/clients";
import {
  UnitManifestError,
  clientUnitManifestDescriptor,
  extensionUnitManifestDescriptor,
  validateUnitManifest,
  validateUnitIconDeclaration,
} from "./unitManifest.js";

describe("stored unit icons", () => {
  it.each([undefined, "🎯", "👩🏽‍💻", "./assets/icon.svg", "./icon.png"])(
    "accepts stored declaration %s",
    (icon) => expect(() => validateUnitIconDeclaration(icon)).not.toThrow()
  );
  it.each([
    "lucide:orbit",
    "brand:git",
    "orbit",
    "",
    "🎯 Task",
    42,
    "https://example.com/icon.svg",
    "data:image/svg+xml;base64,AAA",
    "./../icon.svg",
  ])("rejects unsupported declaration %s with authoring guidance", (icon) => {
    try {
      validateUnitIconDeclaration(icon);
      throw new Error("Expected declaration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UnitManifestError);
      expect(error).toMatchObject({ code: "MANIFEST_ICON" });
      expect((error as Error).message).toContain("setUnitIcon");
    }
  });
});

describe("client capability catalog", () => {
  it("derives each runtime's vocabulary from the hosts that run it", () => {
    for (const runtime of ["web", "react-native", "terminal"] as const) {
      const hostsOfRuntime = HOST_KINDS.filter((host) => HOST_RUNTIME[host] === runtime);
      const vocabulary = new Set(capabilitiesForRuntime(runtime));
      for (const [capability, descriptor] of Object.entries(CLIENT_CAPABILITY_CATALOG)) {
        const implemented = (descriptor.hosts as readonly string[]).some((host) =>
          (hostsOfRuntime as readonly string[]).includes(host)
        );
        expect(vocabulary.has(capability as keyof typeof CLIENT_CAPABILITY_CATALOG)).toBe(
          implemented
        );
      }
    }
    expect(capabilitiesForRuntime("web")).toContain("tray");
    expect(capabilitiesForRuntime("terminal")).not.toContain("tray");
  });
});

describe("validateUnitManifest", () => {
  it("validates extension manifests through the shared unit validator", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            dependencyMode: "external",
            methodAuthority: {
              invoke: {
                website: { kind: "eligible", rationale: "Explicit extension fixture contract." },
                effect: { kind: "open" },
              },
            },
            providerContracts: {
              gitInterop: { methods: ["upstreamStatus", "pushUpstream"] },
            },
            contributes: { buildTargets: ["react-native"] },
          },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).not.toThrow();

    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        { extension: { activationEvents: ["onInvoke"], methodAuthority: {} } },
        { unitName: "@workspace-extensions/lazy" }
      )
    ).not.toThrow();
  });

  it("requires extension sourcemaps without prescribing their storage format", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          sourcemap: false,
          extension: { activationEvents: ["onInvoke"], methodAuthority: {} },
        },
        { unitName: "@workspace-extensions/no-maps" }
      )
    ).toThrow(/must enable sourcemaps/);
  });

  it("requires a closed-world extension method authority declaration", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        { extension: { activationEvents: ["*"] } },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(/must declare methodAuthority for every public method/);
  });

  it("rejects ambiguous or unknown extension activation policies", () => {
    for (const activationEvents of [[], ["*", "onInvoke"], ["onCommand"]]) {
      expect(() =>
        validateUnitManifest(
          extensionUnitManifestDescriptor,
          { extension: { activationEvents, methodAuthority: {} } },
          { unitName: "@workspace-extensions/a" }
        )
      ).toThrow(/exactly \["\*"\] or \["onInvoke"\]/);
    }
  });

  it("rejects malformed provider contract namespaces", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            methodAuthority: {},
            providerContracts: {
              gitInterop: { methods: ["pushUpstream", "pushUpstream"] },
            },
          },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(/non-empty array of unique method names/);

    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            methodAuthority: {},
            providerContracts: {
              "git-interop": { methods: ["pushUpstream"] },
            },
          },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(/valid provider slot/);

    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            methodAuthority: {},
            providerContracts: {
              gitInterop: { methods: ["pushUpstream"], public: true },
            },
          },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(/exactly one methods field/);
  });

  it("rejects unknown extension build-provider targets", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            methodAuthority: {},
            contributes: { buildTargets: ["electron"] },
          },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(/contributes.buildTargets/);
  });

  it("rejects extension manifests with foreign kind blocks", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: { activationEvents: ["*"], methodAuthority: {} },
          client: { id: "shell", runtime: "web", hostAbi: "web-host-1", entry: "index.tsx" },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(UnitManifestError);
  });

  const webClient = (overrides: Record<string, unknown> = {}) => ({
    client: {
      id: "desktop-browser",
      runtime: "web",
      hostAbi: "web-host-1",
      entry: "index.tsx",
      capabilities: { required: ["panel-hosting"], optional: ["native-menus", "notifications"] },
      ...overrides,
    },
  });
  const validateClient = (manifest: unknown, unitName = "@workspace-clients/desktop-browser") =>
    validateUnitManifest(clientUnitManifestDescriptor, manifest, { unitName });

  it("validates a web client manifest", () => {
    expect(() => validateClient(webClient())).not.toThrow();
  });

  it("validates a terminal client with an integration command and intents", () => {
    expect(() =>
      validateClient({
        client: {
          id: "chat",
          runtime: "terminal",
          hostAbi: "terminal-host-1",
          entry: "index.ts",
          capabilities: { optional: ["clipboard"] },
          integration: { terminal: { command: "chat" } },
          intents: [{ name: "open", kind: "foreground" }],
        },
      })
    ).not.toThrow();
  });

  it("rejects intent fields the contract does not define", () => {
    expect(() =>
      validateClient(
        webClient({
          intents: [
            { name: "ask", kind: "background", handler: "chat.v1#ask", result: "text-stream" },
          ],
        })
      )
    ).toThrow(/intent "ask" has unknown field "result"/);
  });

  it("rejects an entry that escapes the package", () => {
    expect(() => validateClient(webClient({ entry: "../native/App" }))).toThrow(
      /package-relative module path/
    );
  });

  it("rejects fields a client may not declare", () => {
    expect(() => validateClient(webClient({ preload: "preload.ts" }))).toThrow(
      /unknown field "preload"/
    );
  });

  it("rejects the legacy app block and unknown runtimes", () => {
    expect(() => validateClient({ app: { target: "electron", renderer: "index.tsx" } })).toThrow(
      /vibestudio.client must be an object/
    );
    expect(() => validateClient(webClient({ runtime: "electron" }))).toThrow(
      /runtime must be one of/
    );
  });

  it("requires a host ABI of the client's runtime", () => {
    expect(() => validateClient(webClient({ hostAbi: "rn-host-6" }))).toThrow(
      /hostAbi must be "web-host-<version>"/
    );
  });

  it("rejects capabilities the runtime's hosts do not implement", () => {
    expect(() =>
      validateClient({
        client: {
          id: "mobile",
          runtime: "react-native",
          hostAbi: "rn-host-6",
          entry: "index.tsx",
          capabilities: { optional: ["native-menus"] },
        },
      })
    ).toThrow(/known react-native capabilities/);
  });

  it("rejects a capability listed as both required and optional", () => {
    expect(() =>
      validateClient(
        webClient({ capabilities: { required: ["notifications"], optional: ["notifications"] } })
      )
    ).toThrow(/both required and optional/);
  });

  it("rejects reserved terminal commands", () => {
    expect(() =>
      validateClient({
        client: {
          id: "chat",
          runtime: "terminal",
          hostAbi: "terminal-host-1",
          entry: "index.ts",
          integration: { terminal: { command: "agent" } },
        },
      })
    ).toThrow(/built-in vibestudio command/);
  });
});

import { describe, expect, it } from "vitest";
import {
  APP_CAPABILITIES_BY_NATIVE_HOST,
  APP_CAPABILITIES_BY_TARGET,
  UnitManifestError,
  appUnitManifestDescriptor,
  extensionUnitManifestDescriptor,
  validateUnitManifest,
} from "./unitManifest.js";

describe("app capability catalog", () => {
  it("derives native-host support as a strict subset of the target vocabulary", () => {
    const electronVocabulary = new Set(APP_CAPABILITIES_BY_TARGET.electron);
    const reactNativeVocabulary = new Set(APP_CAPABILITIES_BY_TARGET["react-native"]);

    expect(
      APP_CAPABILITIES_BY_NATIVE_HOST.electron.every((capability) =>
        electronVocabulary.has(capability)
      )
    ).toBe(true);
    expect(electronVocabulary.has("tray")).toBe(true);
    expect(APP_CAPABILITIES_BY_NATIVE_HOST.electron).not.toContain("tray");
    expect(
      APP_CAPABILITIES_BY_NATIVE_HOST["react-native"].every((capability) =>
        reactNativeVocabulary.has(capability)
      )
    ).toBe(true);
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
              invoke: { effect: { kind: "open" } },
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
          app: { target: "electron", renderer: "index.tsx" },
        },
        { unitName: "@workspace-extensions/a" }
      )
    ).toThrow(UnitManifestError);
  });

  it("validates pure-thin Electron app manifests", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        {
          app: {
            target: "electron",
            renderer: "index.tsx",
            capabilities: ["native-menus", "notifications", "fs-write"],
          },
        },
        { unitName: "@workspace-apps/shell" }
      )
    ).not.toThrow();
  });

  it("rejects native-process fields in app manifests", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "electron", renderer: "index.tsx", preload: "preload.ts" } },
        { unitName: "@workspace-apps/shell" }
      )
    ).toThrow(/pure-thin/);
  });

  it("rejects dist as an app manifest target", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "dist", renderer: "index.tsx", distDir: "dist" } },
        { unitName: "@workspace-apps/prebuilt" }
      )
    ).toThrow(/target must be "electron", "react-native", or "terminal"/);
  });

  it("validates terminal app manifests with terminal capabilities", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        {
          app: {
            target: "terminal",
            entry: "index.ts",
            capabilities: ["clipboard"],
          },
        },
        { unitName: "@workspace-apps/remote-cli" }
      )
    ).not.toThrow();
  });

  it("requires React Native ABI and component name", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "react-native", renderer: "index.tsx", rnComponentName: "Vibestudio" } },
        { unitName: "@workspace-apps/mobile" }
      )
    ).toThrow(/requires rnComponentName and rnHostAbi/);
  });

  it("rejects target-unknown capabilities", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "react-native", renderer: "index.tsx", capabilities: ["native-menus"] } },
        { unitName: "@workspace-apps/mobile" }
      )
    ).toThrow(/known react-native capabilities/);
  });
});

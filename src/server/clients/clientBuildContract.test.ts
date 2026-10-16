import { describe, expect, it } from "vitest";
import type { ClientRuntime } from "@vibestudio/workspace-contracts/clients";
import { validateClientBuildContract } from "./clientBuildContract.js";

type Build = Parameters<typeof validateClientBuildContract>[2];

const INTEGRITY = `sha256-${"b".repeat(64)}`;
const PROVIDER = {
  name: "extensions/react-native",
  activeEv: "ev-1",
  activeBuildKey: "key-1",
  contractVersion: "1",
};

type TestArtifact = { path: string; role: string; platform?: string; integrity?: string };

function build(
  runtime: ClientRuntime,
  hostAbi: string,
  artifacts: TestArtifact[],
  overrides: { provider?: unknown } = {}
): Build {
  return {
    metadata: {
      execution: { executionDigest: "a".repeat(64) },
      details: {
        kind: "client",
        clientId: "chat",
        runtime,
        hostAbi,
        ...(runtime === "react-native" ? { provider: overrides.provider ?? PROVIDER } : {}),
      },
    },
    artifacts: artifacts.map((artifact) => ({ integrity: INTEGRITY, ...artifact })),
  } as unknown as Build;
}

const terminal = (artifacts: TestArtifact[]) => build("terminal", "terminal-host-1", artifacts);
const expectTerminal = { runtime: "terminal", hostAbi: "terminal-host-1" } as const;

describe("validateClientBuildContract", () => {
  it("accepts a terminal build with one primary .mjs entry", () => {
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectTerminal,
        terminal([{ path: "index.mjs", role: "primary" }])
      )
    ).not.toThrow();
  });

  it("names the client and runtime when the terminal entry is not a single .mjs", () => {
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectTerminal,
        terminal([{ path: "index.js", role: "primary" }])
      )
    ).toThrow(
      "Terminal client clients/chat build must include exactly one primary ESM .mjs program"
    );
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectTerminal,
        terminal([
          { path: "a.mjs", role: "primary" },
          { path: "b.mjs", role: "primary" },
        ])
      )
    ).toThrow(/exactly one primary ESM \.mjs program/u);
    expect(() => validateClientBuildContract("clients/chat", expectTerminal, terminal([]))).toThrow(
      /exactly one primary ESM \.mjs program/u
    );
  });

  it("accepts a web build with one primary HTML page and refuses anything else", () => {
    const web = (artifacts: TestArtifact[]) => build("web", "web-host-1", artifacts);
    const expectWeb = { runtime: "web", hostAbi: "web-host-1" } as const;
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectWeb,
        web([
          { path: "index.html", role: "primary" },
          { path: "app.js", role: "asset" },
        ])
      )
    ).not.toThrow();
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectWeb,
        web([{ path: "app.js", role: "primary" }])
      )
    ).toThrow("Web client clients/chat build must include exactly one primary HTML page");
  });

  it("requires one primary bundle per mobile platform and a provider for React Native", () => {
    const expectRn = { runtime: "react-native", hostAbi: "rn-host-6" } as const;
    const rn = (artifacts: TestArtifact[], provider?: unknown) =>
      build("react-native", "rn-host-6", artifacts, provider === undefined ? {} : { provider });
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectRn,
        rn([
          { path: "android.bundle", role: "primary", platform: "android" },
          { path: "ios.bundle", role: "primary", platform: "ios" },
          { path: "logo.png", role: "asset", platform: "ios" },
        ])
      )
    ).not.toThrow();
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectRn,
        rn([
          { path: "a.bundle", role: "primary", platform: "ios" },
          { path: "b.bundle", role: "primary", platform: "ios" },
        ])
      )
    ).toThrow("has more than one primary bundle for ios");
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectRn,
        rn([{ path: "a.bundle", role: "primary" }])
      )
    ).toThrow(/has no mobile platform/u);
    expect(() => validateClientBuildContract("clients/chat", expectRn, rn([]))).toThrow(
      "build has no primary bundle"
    );
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        expectRn,
        rn([{ path: "a.bundle", role: "primary", platform: "ios" }], { name: "" })
      )
    ).toThrow("does not identify the build provider");
  });

  it("refuses a build whose metadata belongs to another runtime or ABI", () => {
    const built = terminal([{ path: "index.mjs", role: "primary" }]);
    expect(() =>
      validateClientBuildContract("clients/chat", { runtime: "web", hostAbi: "web-host-1" }, built)
    ).toThrow("Web client clients/chat build is missing web client metadata");
    expect(() =>
      validateClientBuildContract(
        "clients/chat",
        { runtime: "terminal", hostAbi: "terminal-host-2" },
        built
      )
    ).toThrow("produced for terminal-host-1, but its manifest declares terminal-host-2");
  });

  it("refuses a build with no sealed execution identity", () => {
    const built = terminal([{ path: "index.mjs", role: "primary" }]);
    (built.metadata as { execution?: unknown }).execution = undefined;
    expect(() => validateClientBuildContract("clients/chat", expectTerminal, built)).toThrow(
      "Terminal client clients/chat build is missing a sealed execution identity"
    );
  });

  it("refuses an artifact without a sha256 integrity value", () => {
    const built = terminal([{ path: "index.mjs", role: "primary", integrity: "md5-abc" }]);
    expect(() => validateClientBuildContract("clients/chat", expectTerminal, built)).toThrow(
      "artifact index.mjs is missing integrity"
    );
  });
});

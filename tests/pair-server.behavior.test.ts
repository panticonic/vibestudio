// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  hostBuildHasWorkspaceTemplatePins,
  parsePairArgs,
  runPairServer,
} from "../scripts/cli/lib/pair-server.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { hostArtifactRootForServerEntry } from "../scripts/host-build-generations.mjs";

vi.mock("../scripts/host-build-generations.mjs", () => ({
  readCurrentHostBuildGeneration: vi.fn(() => "/isolated/host-generation"),
  // Launchers share one derivation of the coordinate a host runs from, so the
  // isolated generation has to answer through it too.
  hostArtifactRootForServerEntry: vi.fn((_root: string, entry: string) =>
    entry === "src/server/index.ts" ? "/isolated/host-generation" : "/repo/dist"
  ),
}));

class FakeChild extends EventEmitter {
  pid = 43210;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | string) => {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  });
}

const config = {
  commandName: "pair-test",
  usage: ["pair-test"],
  logPrefix: "pair-test",
  portEnv: ["VIBESTUDIO_PAIR_TEST_PORT"],
  devEnv: "VIBESTUDIO_PAIR_TEST_DEV",
  bannerTitle: "Pair Test",
  deepLinkLabel: "Deep link",
  instructions: "Pair from test.",
};

function invite() {
  const pairing = {
    endpointId: "ab".repeat(32),
    relays: ["https://relay.example/"],
    v: 5 as const,
    code: `${"C".repeat(21)}A`,
  };
  return {
    ...pairing,
    deepLink: createConnectDeepLink(pairing),
    pairUrl: createConnectPairUrl(pairing),
    expiresInMs: 60_000,
    // Expiry is authoritative server state carried alongside the invite, not
    // link material encoded into the compact carrier.
    expiresAt: 4_000_000_000_000,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
  };
}

function ready(rootInvite: ReturnType<typeof invite> | null) {
  return {
    mode: "hub",
    gatewayUrl: "http://127.0.0.1:3456",
    rootInvite,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
    gatewayPort: 3456,
    pid: 4242,
    version: "0.1.0-test",
    buildId: "a".repeat(64),
    workspaces: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pair-server runner", () => {
  it("pins source pairing to the prepared generation rather than an inherited artifact root", async () => {
    vi.stubEnv("VIBESTUDIO_SERVER_ENTRY", "live");
    vi.stubEnv("VIBESTUDIO_HOST_ARTIFACT_ROOT", "/unrelated/host-generation");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const child = new FakeChild();
    const prepareSourceServer = vi.fn();
    await runPairServer(config, [], {
      prepareSourceServer,
      developmentWorkspaceTemplateEnv: () => ({}),
      spawnServer({ env }: { env: NodeJS.ProcessEnv }) {
        expect(prepareSourceServer).toHaveBeenCalledOnce();
        // Resolved through the derivation every launcher shares, so a launcher
        // that reimplements it cannot quietly diverge from this guarantee.
        expect(hostArtifactRootForServerEntry).toHaveBeenCalledWith(
          expect.any(String),
          "src/server/index.ts"
        );
        // And resolved only after the rebuild, which is what publishes the
        // generation it names. Asking first reads a file that does not exist
        // yet, and the server then exits before readiness.
        expect(vi.mocked(prepareSourceServer).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(hostArtifactRootForServerEntry).mock.invocationCallOrder[0]!
        );
        expect(env.VIBESTUDIO_HOST_ARTIFACT_ROOT).toBe("/isolated/host-generation");
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
      onChildExit: () => true,
    });
  });

  it("accepts only explicit canonical unique HTTPS relays", () => {
    expect(parsePairArgs(["--relay-url", "https://relay.example/"], config).relayUrls).toEqual([
      "https://relay.example/",
    ]);
    expect(() => parsePairArgs(["--relay-url", "http://relay.example/"], config)).toThrow(
      /canonical HTTPS/
    );
    expect(() =>
      parsePairArgs(
        ["--relay-url", "https://relay.example/", "--relay-url", "https://relay.example/"],
        config
      )
    ).toThrow(/unique/);
    expect(() => parsePairArgs(["--host", "0.0.0.0"], config)).toThrow(
      /gateway binds loopback only/
    );
  });

  it("passes the ordered relay set to the Iroh server environment", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const child = new FakeChild();
    const operation = runPairServer(
      config,
      ["--relay-url", "https://one.example/", "--relay-url", "https://two.example/"],
      {
        prepareSourceServer: () => undefined,
        developmentWorkspaceTemplateEnv: () => ({}),
        spawnServer({ env, serverArgs }: { env: NodeJS.ProcessEnv; serverArgs: string[] }) {
          expect(env.VIBESTUDIO_HOST).toBe("127.0.0.1");
          expect(env.VIBESTUDIO_IROH_RELAYS).toBe("https://one.example/,https://two.example/");
          expect(serverArgs).toContain("--ready-file");
          expect(serverArgs).not.toContain("--require-electron-ready");
          expect(serverArgs).not.toContain("--require-mobile-ready");
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
        onChildExit: () => true,
      }
    );
    await operation;
  });

  it("prints Endpoint ID and relays from the authoritative ready invite", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";
    const operation = runPairServer(config, [], {
      prepareSourceServer: () => undefined,
      developmentWorkspaceTemplateEnv: () => ({}),
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        readyFile = serverArgs[serverArgs.indexOf("--ready-file") + 1]!;
        setTimeout(() => fs.writeFileSync(readyFile, JSON.stringify(ready(invite()))), 10);
        return child;
      },
      onChildExit: () => true,
    });
    await vi.waitFor(() => {
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain(`Endpoint ID: ${"ab".repeat(32)}`);
      expect(output).toContain("Relays:      https://relay.example/");
    });
    child.emit("exit", 0, null);
    await operation;
  });
});

describe("host build workspace template pins", () => {
  // A packaged app names its distributions in the release artifact; a source
  // checkout ships the same artifact WITHOUT them. That difference is the only
  // signal `remote serve` has for whether it must resolve a development Base,
  // and getting it wrong either overrides a real release or pairs a device into
  // a server that cannot create a workspace.
  function artifactRoot(contents: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "pair-pins-"));
    mkdirSync(join(root, "build-resources"), { recursive: true });
    writeFileSync(
      join(root, "build-resources", "base-template-release.json"),
      JSON.stringify(contents)
    );
    return root;
  }

  it("reports pins when the release artifact names the distributions", () => {
    const root = artifactRoot({
      format: 1,
      workspaceTemplates: { base: {}, personal: {}, system: {} },
    });
    expect(hostBuildHasWorkspaceTemplatePins(root)).toBe(true);
  });

  it("reports none for a source checkout artifact that omits them", () => {
    const root = artifactRoot({ format: 1, baseTemplate: {} });
    expect(hostBuildHasWorkspaceTemplatePins(root)).toBe(false);
  });

  it("reports none when the host build ships no artifact at all", () => {
    expect(hostBuildHasWorkspaceTemplatePins(mkdtempSync(join(tmpdir(), "pair-pins-")))).toBe(false);
  });
});

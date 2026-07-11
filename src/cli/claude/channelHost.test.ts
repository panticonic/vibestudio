import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcClient } from "../rpcClient.js";
import {
  bridgeInstructions,
  createSkillResources,
  normalizeServerUrl,
  resolveBridgeConfig,
  skillNameFromUri,
  skillResourceUri,
  WORKSPACE_SKILL_ADDENDUM,
  type AdoptionEnvironment,
  type BridgeConfig,
} from "./channelHost.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "channel-host-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const LAUNCH_ENV = {
  VIBESTUDIO_AGENT_TOKEN: "agent:agt_1:secret",
  VIBESTUDIO_SERVER_URL: "http://127.0.0.1:4123",
  VIBESTUDIO_ENTITY_ID: "ent-1",
  VIBESTUDIO_CONTEXT_ID: "ctx-1",
  VIBESTUDIO_CHANNEL_ID: "chan-1",
  VIBESTUDIO_VESSEL_REF: "do:workers/linked-agent:LinkedAgentWorker:linked:ent-1",
} as NodeJS.ProcessEnv;

const DEVICE_CREDS = {
  schemaVersion: 3,
  kind: "device",
  url: "webrtc://room-1234/_workspace/dev",
  workspaceName: "dev",
  serverId: `srv_${"S".repeat(24)}`,
  deviceId: `dev_${"D".repeat(24)}`,
  refreshToken: "R".repeat(43),
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-1234",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2,
    ice: "all",
  },
  pairedAt: 1,
} satisfies NonNullable<ReturnType<typeof import("../credentialStore.js").loadCliCredentials>>;

function fakeClient(handlers: Record<string, (args: unknown[]) => unknown>): RpcClient {
  return {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected call ${method}`);
      return handler(args);
    }),
    close: vi.fn(async () => {}),
  } as unknown as RpcClient;
}

function preparedFor(contextFolder: string) {
  return {
    entityId: "ent-9",
    contextId: "ctx-9",
    channelId: "chan-9",
    vesselRef: "do:workers/linked-agent:LinkedAgentWorker:linked:ent-9",
    contextFolder,
    env: {
      VIBESTUDIO_AGENT_TOKEN: "agent:agt_9:s",
      VIBESTUDIO_SERVER_URL: "http://127.0.0.1:4123",
      VIBESTUDIO_LAUNCH_PROFILE: path.join(contextFolder, "..", "profile"),
    },
    argv: ["claude"],
  };
}

describe("normalizeServerUrl", () => {
  it("accepts a canonical base and rejects websocket endpoint aliases", () => {
    expect(normalizeServerUrl("http://127.0.0.1:4123")).toBe("http://127.0.0.1:4123");
    expect(() => normalizeServerUrl("ws://127.0.0.1:4123/rpc")).toThrow(
      /Unsupported server URL protocol/
    );
  });
});

describe("resolveBridgeConfig", () => {
  it("prefers the complete canonical launch-profile env", async () => {
    const config = await resolveBridgeConfig(
      { ...LAUNCH_ENV, VIBESTUDIO_LAUNCH_PROFILE: tmpRoot },
      { cwd: tmpRoot }
    );
    expect(config.mode).toBe("launched");
    expect(config.serverUrl).toBe("http://127.0.0.1:4123");
    expect(config.vesselRef).toBe(LAUNCH_ENV["VIBESTUDIO_VESSEL_REF"]);
    expect(config.hookSocketPaths[0]).toBe(path.join(tmpRoot, "hook.sock"));
    // Fallback per-context socket is always listened on too.
    expect(config.hookSocketPaths[1]).toContain("agent-sockets");
  });

  it("honors an explicit VIBESTUDIO_VESSEL_REF", async () => {
    const config = await resolveBridgeConfig(
      { ...LAUNCH_ENV, VIBESTUDIO_VESSEL_REF: "do:x:Y:z" },
      { cwd: tmpRoot }
    );
    expect(config.vesselRef).toBe("do:x:Y:z");
  });

  it("parses the subagent duty out of the launch env", async () => {
    const config = await resolveBridgeConfig(
      {
        ...LAUNCH_ENV,
        VIBESTUDIO_SUBAGENT_RUN_ID: "run-1",
        VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: "chan-parent",
        VIBESTUDIO_SUBAGENT_CONTRACT: "## Subagent Operating Contract\ncontract body",
      },
      { cwd: tmpRoot }
    );
    expect(config.subagent).toEqual({
      runId: "run-1",
      parentChannelId: "chan-parent",
      contract: "## Subagent Operating Contract\ncontract body",
    });
  });

  it("leaves subagent unset without the run-id env", async () => {
    const config = await resolveBridgeConfig(
      { ...LAUNCH_ENV, VIBESTUDIO_SUBAGENT_CONTRACT: "orphan contract" },
      { cwd: tmpRoot }
    );
    expect(config.subagent).toBeUndefined();
  });

  it("rejects a partial launch env loudly", async () => {
    await expect(
      resolveBridgeConfig({ VIBESTUDIO_AGENT_TOKEN: "agent:a:s" } as NodeJS.ProcessEnv, {
        cwd: tmpRoot,
      })
    ).rejects.toThrow(/incomplete launch profile env/);
  });

  it("adopts via the cwd marker: resolves the primary channel and prepares", async () => {
    const contextFolder = path.join(tmpRoot, "ctx");
    fs.mkdirSync(contextFolder, { recursive: true });
    fs.writeFileSync(
      path.join(contextFolder, ".vibestudio-context.json"),
      JSON.stringify({ contextId: "ctx-9" })
    );
    const invocations: Array<{ method: string }> = [];
    const client = fakeClient({
      "extensions.invokeProvider": (args) => {
        const [provider, method, methodArgs] = args as [string, string, unknown[]];
        expect(provider).toBe("claudeCode");
        invocations.push({ method });
        if (method === "resolvePrimaryChannel") return { channelId: "chan-9" };
        if (method === "prepare") {
          expect(methodArgs).toEqual([{ channelId: "chan-9" }]);
          return preparedFor(contextFolder);
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const adoption: AdoptionEnvironment = {
      cwd: contextFolder,
      loadCredentials: () => DEVICE_CREDS,
      makeClient: () => client,
    };
    const config = await resolveBridgeConfig({}, adoption);
    expect(config.mode).toBe("adopted");
    expect(config.channelId).toBe("chan-9");
    expect(config.agentToken).toBe("agent:agt_9:s");
    expect(invocations.map((entry) => entry.method)).toEqual(["resolvePrimaryChannel", "prepare"]);
  });

  it("refuses adoption outside a context folder without --channel", async () => {
    const adoption: AdoptionEnvironment = {
      cwd: tmpRoot, // no marker anywhere under tmp
      loadCredentials: () => DEVICE_CREDS,
      makeClient: () => fakeClient({}),
    };
    await expect(resolveBridgeConfig({}, adoption)).rejects.toThrow(/adoption refused/);
  });

  it("divergence guard: explicit --channel outside the context folder warns loudly", async () => {
    const contextFolder = path.join(tmpRoot, "real-context");
    fs.mkdirSync(contextFolder, { recursive: true });
    const elsewhere = path.join(tmpRoot, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const warnings: string[] = [];
    const client = fakeClient({
      "extensions.invokeProvider": (args) => {
        const [provider, method] = args as [string, string];
        expect(provider).toBe("claudeCode");
        if (method === "prepare") return preparedFor(contextFolder);
        throw new Error(`unexpected ${method}`);
      },
    });
    const adoption: AdoptionEnvironment = {
      cwd: elsewhere,
      channelFlag: "chan-9",
      loadCredentials: () => DEVICE_CREDS,
      makeClient: () => client,
      warn: (message) => warnings.push(message),
    };
    const config = await resolveBridgeConfig({}, adoption);
    expect(config.mode).toBe("adopted");
    expect(warnings.join("\n")).toMatch(/DIFFERENT trees/);
  });

  it("divergence guard: marker-resolved channel whose folder excludes cwd refuses", async () => {
    // Marker present (so a channel resolves), but prepare returns a context
    // folder that does NOT contain cwd — e.g. a stale/moved marker.
    const markerDir = path.join(tmpRoot, "stale");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, ".vibestudio-context.json"),
      JSON.stringify({ contextId: "ctx-9" })
    );
    const realFolder = path.join(tmpRoot, "actual-context");
    fs.mkdirSync(realFolder, { recursive: true });
    const client = fakeClient({
      "extensions.invokeProvider": (args) => {
        const [provider, method] = args as [string, string];
        expect(provider).toBe("claudeCode");
        if (method === "resolvePrimaryChannel") return { channelId: "chan-9" };
        if (method === "prepare") return preparedFor(realFolder);
        throw new Error(`unexpected ${method}`);
      },
    });
    const adoption: AdoptionEnvironment = {
      cwd: markerDir,
      loadCredentials: () => DEVICE_CREDS,
      makeClient: () => client,
    };
    await expect(resolveBridgeConfig({}, adoption)).rejects.toThrow(/outside the context folder/);
  });

  it("requires a paired device for adoption", async () => {
    const adoption: AdoptionEnvironment = {
      cwd: tmpRoot,
      loadCredentials: () => null,
    };
    await expect(resolveBridgeConfig({}, adoption)).rejects.toThrow(/paired device/);
  });
});

describe("bridgeInstructions", () => {
  const baseConfig: BridgeConfig = {
    mode: "launched",
    serverUrl: "http://127.0.0.1:4123",
    agentToken: "agent:agt_1:secret",
    entityId: "ent-1",
    contextId: "ctx-1",
    channelId: "chan-1",
    vesselRef: "do:x:Y:z",
    hookSocketPaths: [],
  };

  it("hedges on task duty for a plain linked session", () => {
    const text = bridgeInstructions(baseConfig);
    expect(text).toContain("If this is a task channel");
    expect(text).not.toContain("spawned as a SUBAGENT");
    // Discovery pointers are always present.
    expect(text).toContain("vibestudio-agent");
    expect(text).toContain("materializes repos on demand");
  });

  it("states the subagent duty definitively and embeds the contract", () => {
    const text = bridgeInstructions({
      ...baseConfig,
      subagent: {
        runId: "run-7",
        parentChannelId: "chan-parent",
        contract: "## Subagent Operating Contract\nOnly `complete` ends this subagent run.",
      },
    });
    expect(text).toContain("spawned as a SUBAGENT (run run-7)");
    expect(text).toContain("Only `complete` ends this subagent run.");
    expect(text).toContain("do NOT end your final reply without calling `complete`");
    expect(text).not.toContain("If this is a task channel");
  });

  it("still states the duty when the contract env is missing", () => {
    const text = bridgeInstructions({
      ...baseConfig,
      subagent: { runId: "run-8", parentChannelId: "chan-parent", contract: "" },
    });
    expect(text).toContain("spawned as a SUBAGENT (run run-8)");
    expect(text).toContain("calling `complete`");
  });
});

describe("workspace skill resources", () => {
  it("maps the workspace skill catalog to MCP resource descriptors keyed by dirPath", async () => {
    const resources = createSkillResources(async (method, args) => {
      expect(method).toBe("workspace.listSkills");
      expect(args).toEqual([]);
      return [
        {
          name: "onboarding",
          description: "Get started",
          dirPath: "skills/onboarding",
          skillPath: "skills/onboarding/SKILL.md",
        },
        // Repo-local skill (post skills-upgrade): read key is the repo path.
        {
          name: "agentic-do",
          description: "Agent runtime work",
          dirPath: "packages/agentic-do",
          skillPath: "packages/agentic-do/SKILL.md",
        },
      ] as never;
    });
    await expect(resources.list()).resolves.toEqual([
      {
        uri: "vibestudio-skill://skills%2Fonboarding",
        name: "onboarding",
        description: "Workspace skill (skills/onboarding): Get started",
        mimeType: "text/markdown",
      },
      {
        uri: "vibestudio-skill://packages%2Fagentic-do",
        name: "agentic-do",
        description: "Workspace skill (packages/agentic-do): Agent runtime work",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("serves the linked-session addendum on the first read only", async () => {
    const resources = createSkillResources(async (method) => {
      expect(method).toBe("workspace.readSkill");
      return "# Skill body" as never;
    });
    const first = await resources.read("vibestudio-skill://subagents");
    const firstText = first.contents[0]!.text;
    expect(firstText.startsWith(WORKSPACE_SKILL_ADDENDUM)).toBe(true);
    expect(firstText).toContain("translate as you read");
    expect(firstText.endsWith("# Skill body")).toBe(true);

    // Second read (any skill): session already has the translation rules.
    const second = await resources.read("vibestudio-skill://system-testing");
    expect(second.contents[0]!.text).toBe("# Skill body");
  });

  it("refuses non-skill uris and round-trips encoded names", async () => {
    const resources = createSkillResources(async () => "unused" as never);
    await expect(resources.read("file:///etc/passwd")).rejects.toThrow(
      /not a workspace skill resource/
    );
    expect(skillNameFromUri(skillResourceUri("gad-context"))).toBe("gad-context");
    expect(skillNameFromUri("vibestudio-skill://")).toBeNull();
  });
});

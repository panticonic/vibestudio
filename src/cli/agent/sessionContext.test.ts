import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  creds: null as unknown,
  session: null as unknown,
  loadCredsCalls: 0,
  loadSessionCalls: 0,
}));

vi.mock("../credentialStore.js", () => ({
  loadCliCredentials: () => {
    state.loadCredsCalls++;
    return state.creds;
  },
}));
vi.mock("../sessionStore.js", () => ({
  isValidSessionName: () => true,
  loadAgentSession: () => {
    state.loadSessionCalls++;
    return state.session;
  },
}));

import { findContextBinding, resolveSessionScope } from "./sessionContext.js";
import { contextBinding } from "@vibestudio/shared/contextBinding";

const ENV_KEYS = [
  "VIBESTUDIO_AGENT_TOKEN",
  "VIBESTUDIO_SERVER_URL",
  "VIBESTUDIO_CONTEXT_ID",
  "VIBESTUDIO_ENTITY_ID",
];
let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
const tmpDirs: string[] = [];

function mkTemp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vs-scope-")));
  tmpDirs.push(dir);
  return dir;
}
function inv(flags: Record<string, string | boolean> = {}) {
  return { positionals: [], flags, flagsMulti: () => [] };
}
const deviceCreds = {
  schemaVersion: 4 as const,
  kind: "device" as const,
  url: "webrtc://room-1234/_workspace/ws",
  workspaceId: "workspace-1",
  workspaceName: "ws",
  serverId: `srv_${"S".repeat(24)}`,
  deviceId: `dev_${"D".repeat(24)}`,
  refreshToken: "R".repeat(43),
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  },
  workspacePairing: {
    room: "room-1234",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  },
  pairedAt: 1,
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedCwd = process.cwd();
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  state.creds = null;
  state.session = null;
  state.loadCredsCalls = 0;
  state.loadSessionCalls = 0;
  // Neutral cwd with no binding so the default tiers are exercised deterministically.
  process.chdir(mkTemp());
});
afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveSessionScope precedence", () => {
  it("tier 1: explicit --session loads the named session file", () => {
    state.creds = deviceCreds;
    state.session = {
      schemaVersion: 3,
      name: "mysess",
      serverId: deviceCreds.serverId,
      workspaceId: deviceCreds.workspaceId,
      workspaceName: deviceCreds.workspaceName,
      entityId: "ent-s",
      contextId: "ctx-sess",
      scopeKey: "sk",
      createdAt: 1,
    };
    const scope = resolveSessionScope(inv({ session: "mysess" }));
    expect(scope.contextId).toBe("ctx-sess");
    expect(scope.callerId).toBe(`shell:dev_${"D".repeat(24)}`);
    expect(scope.session.entityId).toBe("ent-s");
  });

  it("tier 2: VIBESTUDIO_AGENT_TOKEN builds an agent-credential client from env alone", () => {
    process.env["VIBESTUDIO_AGENT_TOKEN"] = "agent:ag-1:secret";
    process.env["VIBESTUDIO_SERVER_URL"] = "http://srv";
    process.env["VIBESTUDIO_CONTEXT_ID"] = "ctx-env";
    process.env["VIBESTUDIO_ENTITY_ID"] = "ent-env";
    const scope = resolveSessionScope(inv());
    expect(scope.contextId).toBe("ctx-env");
    expect(scope.callerId).toBe("agent:ent-env"); // server-derived principal
    expect(scope.session.serverUrl).toBe("http://srv");
    expect(scope.session.entityId).toBe("ent-env");
    // No device credential or session file was consulted.
    expect(state.loadCredsCalls).toBe(0);
    expect(state.loadSessionCalls).toBe(0);
  });

  it("tier 3: discovers a .vibestudio-context.json walking up from cwd", () => {
    const root = mkTemp();
    fs.writeFileSync(
      path.join(root, ".vibestudio-context.json"),
      JSON.stringify(contextBinding({ contextId: "ctx-binding", workspaceId: "workspace-1" }))
    );
    const deep = path.join(root, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    expect(findContextBinding()?.contextId).toBe("ctx-binding");

    state.creds = deviceCreds;
    const scope = resolveSessionScope(inv());
    expect(scope.contextId).toBe("ctx-binding");
    expect(scope.callerId).toBe(`shell:dev_${"D".repeat(24)}`);
    expect(state.loadSessionCalls).toBe(0); // never reached the session-file tier
  });

  it("tier 3: refuses legacy bindings with transient reach fields", () => {
    const root = mkTemp();
    fs.writeFileSync(
      path.join(root, ".vibestudio-context.json"),
      JSON.stringify({
        ...contextBinding({ contextId: "ctx-binding", workspaceId: "workspace-1" }),
        serverUrl: "ws://srv/rpc",
      })
    );
    process.chdir(root);
    state.creds = deviceCreds;
    expect(() => resolveSessionScope(inv())).toThrow(/unknown field/);
  });

  it("tier 2 wins over a present binding (env token beats cwd binding)", () => {
    const root = mkTemp();
    fs.writeFileSync(
      path.join(root, ".vibestudio-context.json"),
      JSON.stringify(contextBinding({ contextId: "ctx-binding", workspaceId: "workspace-1" }))
    );
    process.chdir(root);
    process.env["VIBESTUDIO_AGENT_TOKEN"] = "agent:ag-1:secret";
    process.env["VIBESTUDIO_SERVER_URL"] = "http://srv";
    process.env["VIBESTUDIO_CONTEXT_ID"] = "ctx-env";
    const scope = resolveSessionScope(inv());
    expect(scope.contextId).toBe("ctx-env");
    expect(scope.callerId).toMatch(/^agent:/);
  });

  it("refuses a binding for a different durable workspace", () => {
    const root = mkTemp();
    fs.writeFileSync(
      path.join(root, ".vibestudio-context.json"),
      JSON.stringify(contextBinding({ contextId: "ctx-binding", workspaceId: "workspace-2" }))
    );
    process.chdir(root);
    state.creds = deviceCreds;
    expect(() => resolveSessionScope(inv())).toThrow(/belongs to workspace workspace-2/);
  });

  it("tier 1b: explicit --context with no token/binding uses the device credential", () => {
    state.creds = deviceCreds;
    const scope = resolveSessionScope(inv({ context: "ctx-flag" }));
    expect(scope.contextId).toBe("ctx-flag");
    expect(scope.callerId).toBe(`shell:dev_${"D".repeat(24)}`);
  });
});

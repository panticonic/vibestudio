import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteAgentSession,
  listAgentSessions,
  loadAgentSession,
  saveAgentSession,
  sessionPath,
  type AgentSession,
} from "./sessionStore.js";

function makeSession(name: string): AgentSession {
  return {
    schemaVersion: 1,
    name,
    serverUrl: "https://host.tailnet.ts.net",
    entityId: `session:${name}`,
    contextId: `ctx-${name}`,
    scopeKey: name,
    createdAt: 1750000000000,
  };
}

describe("sessionStore", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-sessions-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a session file with 0600 permissions", () => {
    const session = makeSession("alpha");
    saveAgentSession(session);

    const filePath = path.join(tmpDir, ".config", "vibez1", "agent-sessions", "alpha.json");
    expect(sessionPath("alpha")).toBe(filePath);
    expect(loadAgentSession("alpha")).toEqual(session);
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for missing or malformed session files", () => {
    expect(loadAgentSession("missing")).toBeNull();
    fs.mkdirSync(path.join(tmpDir, ".config", "vibez1", "agent-sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".config", "vibez1", "agent-sessions", "broken.json"),
      "{not json"
    );
    expect(loadAgentSession("broken")).toBeNull();
  });

  it("lists sessions sorted by name and deletes them", () => {
    saveAgentSession(makeSession("beta"));
    saveAgentSession(makeSession("alpha"));
    expect(listAgentSessions().map((session) => session.name)).toEqual(["alpha", "beta"]);

    deleteAgentSession("alpha");
    expect(listAgentSessions().map((session) => session.name)).toEqual(["beta"]);
  });

  it("rejects path-traversal session names", () => {
    expect(() => sessionPath("../evil")).toThrow(/Invalid session name/);
    expect(() => sessionPath("a/b")).toThrow(/Invalid session name/);
  });
});

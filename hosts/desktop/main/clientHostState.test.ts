import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientHostState, type PendingClientUpdateRecord } from "./clientHostState.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), "client-state-"));
  dirs.push(dir);
  return join(dir, "nested", "state.json");
};
const record = (clientId: string, buildKey: string): PendingClientUpdateRecord => ({
  clientId,
  source: `clients/${clientId}`,
  buildKey,
  previousBuildKey: "old",
  effectiveVersion: "2",
  previousEffectiveVersion: "1",
});

describe("ClientHostState", () => {
  it("keeps pending updates and development mode across a restart", () => {
    const path = file();
    const state = new ClientHostState(path);
    state.setPending(record("browser", "bk2"));
    state.setPending(record("browser", "bk3"));
    state.setPending(record("chat", "bk9"));
    state.setDevelopment("browser", true);

    const restarted = new ClientHostState(path);
    expect(restarted.pending().map((r) => [r.clientId, r.buildKey])).toEqual([
      ["browser", "bk3"],
      ["chat", "bk9"],
    ]);
    expect(restarted.isDevelopment("browser")).toBe(true);
    expect(restarted.isDevelopment("chat")).toBe(false);
    restarted.clearPending("chat");
    restarted.setDevelopment("browser", false);
    const again = new ClientHostState(path);
    expect(again.pending().map((r) => r.clientId)).toEqual(["browser"]);
    expect(again.isDevelopment("browser")).toBe(false);
  });

  it("starts empty with no file, and fails loudly on a corrupt one instead of guessing", () => {
    expect(new ClientHostState(file()).pending()).toEqual([]);
    const path = file();
    new ClientHostState(path).setDevelopment("x", true);
    writeFileSync(path, "{not json");
    expect(() => new ClientHostState(path)).toThrow();
    writeFileSync(path, JSON.stringify([1]));
    expect(() => new ClientHostState(path)).toThrow(/malformed/);
  });

  it("writes the file private to the user", () => {
    const path = file();
    new ClientHostState(path).setDevelopment("x", true);
    expect(JSON.parse(readFileSync(path, "utf8")).development).toEqual(["x"]);
  });
});

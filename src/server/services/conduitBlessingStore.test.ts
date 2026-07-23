import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateLayout } from "../stateLayout.js";
import { ConduitBlessingStore } from "./conduitBlessingStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function statePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-conduits-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ConduitBlessingStore", () => {
  it("trusts only the exact product-seeded unit version", () => {
    const root = statePath();
    const store = new ConduitBlessingStore({ statePath: root });
    const identity = {
      repoPath: "workers/agent-worker",
      effectiveVersion: "a".repeat(64),
      executionDigest: "b".repeat(64),
    };

    expect(store.isBlessed(identity)).toBe(false);
    store.seedProductSnapshot(`state:${"c".repeat(64)}`, [identity]);

    const reloaded = new ConduitBlessingStore({ statePath: root });
    expect(reloaded.isSeededFor(`state:${"c".repeat(64)}`)).toBe(true);
    expect(reloaded.isBlessed(identity)).toBe(true);
    expect(reloaded.isBlessed({ ...identity, effectiveVersion: "d".repeat(64) })).toBe(false);

    const replacement = {
      repoPath: "workers/system-agent",
      effectiveVersion: "e".repeat(64),
    };
    reloaded.seedProductSnapshot(`state:${"f".repeat(64)}`, [replacement]);
    expect(reloaded.isSeededFor(`state:${"f".repeat(64)}`)).toBe(true);
    expect(reloaded.isBlessed(identity)).toBe(false);
    expect(reloaded.isBlessed(replacement)).toBe(true);
  });

  it("fails closed on unknown schemas and empty seeds", () => {
    const root = statePath();
    const filePath = stateLayout(root).authority.conduitBlessingsFile;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, blessings: [] }));
    expect(() => new ConduitBlessingStore({ statePath: root })).toThrow(
      "Unknown conduit-blessing schema"
    );

    const clean = statePath();
    expect(() =>
      new ConduitBlessingStore({ statePath: clean }).seedProductSnapshot(
        `state:${"e".repeat(64)}`,
        []
      )
    ).toThrow("resolved no product harnesses");
  });
});

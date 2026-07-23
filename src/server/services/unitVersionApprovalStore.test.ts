import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateLayout } from "../stateLayout.js";
import { UnitVersionApprovalStore } from "./unitVersionApprovalStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function statePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-unit-approvals-"));
  temporaryDirectories.push(directory);
  return directory;
}

const identity = {
  repoPath: "workers/example",
  effectiveVersion: "ev-example",
  authority: {
    requests: [
      {
        capability: "notifications",
        resource: { kind: "exact" as const, key: "workspace" },
        tier: "gated" as const,
        evidence: "exact" as const,
      },
    ],
    evalCeilings: [],
  },
};

describe("UnitVersionApprovalStore", () => {
  it("persists an exact version and manifest decision", () => {
    const root = statePath();
    const store = new UnitVersionApprovalStore({ statePath: root });

    expect(store.has(identity)).toBe(false);
    store.approve(identity, 123);

    expect(new UnitVersionApprovalStore({ statePath: root }).has(identity)).toBe(true);
    expect(
      new UnitVersionApprovalStore({ statePath: root }).has({
        ...identity,
        effectiveVersion: "ev-changed",
      })
    ).toBe(false);
    expect(
      new UnitVersionApprovalStore({ statePath: root }).has({
        ...identity,
        authority: {
          requests: [
            {
              capability: "network",
              resource: { kind: "exact", key: "workspace" },
              tier: "gated",
              evidence: "exact",
            },
          ],
          evalCeilings: [],
        },
      })
    ).toBe(false);
    expect(
      new UnitVersionApprovalStore({ statePath: root }).has({
        ...identity,
        authority: {
          ...identity.authority,
          evalCeilings: [
            {
              audience: "eval",
              purpose: "tool-eval",
              capabilities: identity.authority.requests,
            },
          ],
        },
      })
    ).toBe(false);
  });

  it("fails closed on an unknown persisted schema", () => {
    const root = statePath();
    const filePath = stateLayout(root).authority.approvedUnitVersionsFile;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, approvals: [] }));

    expect(() => new UnitVersionApprovalStore({ statePath: root })).toThrow(
      "Unknown approved-unit-version schema"
    );
  });
});

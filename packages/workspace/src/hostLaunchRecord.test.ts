import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceHostLaunchBinding,
  readWorkspaceHostLaunchRecord,
  writeWorkspaceHostLaunchRecord,
  workspaceHostLaunchRecordPath,
} from "./hostLaunchRecord.js";

const RECORD = {
  version: 1 as const,
  workspaceId: "ws_test",
  systemEpoch: 2,
  stateHash: `state:${"a".repeat(64)}`,
  publicationId: "publication:test",
};

describe("workspace host launch record", () => {
  const roots: string[] = [];
  const root = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-launch-record-"));
    roots.push(value);
    return value;
  };

  afterEach(() => {
    for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
  });

  it("atomically persists and reads the exact semantic binding", () => {
    const statePath = root();
    writeWorkspaceHostLaunchRecord(statePath, RECORD);
    expect(readWorkspaceHostLaunchRecord(statePath)).toEqual(RECORD);
  });

  it("distinguishes absence from corruption and never coerces a record", () => {
    const statePath = root();
    expect(readWorkspaceHostLaunchRecord(statePath)).toBeNull();
    fs.writeFileSync(workspaceHostLaunchRecordPath(statePath), JSON.stringify({ version: 1 }));
    expect(() => readWorkspaceHostLaunchRecord(statePath)).toThrow(/Invalid workspace host/u);
  });

  it.each([
    ["workspace identity", { workspaceId: "ws_other" }],
    ["stale semantic state", { stateHash: `state:${"b".repeat(64)}` }],
    ["wrong publication", { publicationId: "publication:other" }],
    ["manifest epoch", { manifestEpoch: 3 }],
    ["compiled host epoch", { hostEpoch: 3 }],
  ])("rejects a launch record with mismatched %s", (_label, override) => {
    expect(() =>
      assertWorkspaceHostLaunchBinding(RECORD, {
        workspaceId: RECORD.workspaceId,
        stateHash: RECORD.stateHash,
        publicationId: RECORD.publicationId,
        manifestEpoch: RECORD.systemEpoch,
        hostEpoch: RECORD.systemEpoch,
        ...override,
      })
    ).toThrow(/launch record|epoch/i);
  });
});

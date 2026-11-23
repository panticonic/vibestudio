import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionScope } from "./agent/sessionContext.js";
import { loadSystemTestArtifact, type StoredSystemTestRun } from "./systemTestStore.js";
import { retainNativeSystemTestEvidence } from "./systemTestEvidence.js";
import { retainInterruptedRunEvidence } from "./systemTestCommands.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-retention-"));
  roots.push(artifactDir);
  return {
    runId: "st_12345678901234567890123456789012",
    artifactDir,
    createdAt: 10,
    runnerTargetId: "runner",
    config: { names: ["first", "second"], all: false, concurrency: 2 },
  } as StoredSystemTestRun;
}
it("preserves unfinished native exchanges and value receipts without claiming completed calls", async () => {
  const stored = fixture();
  const hash = "a".repeat(64);
  const detail = {
    record: null,
    exchanges: [{ response: "completed model response" }],
    receipt: { hash },
  };
  const dispatch = vi.fn(async (_target: string, method: string, args: unknown[]) => {
    if (method === "listCalls") return [{ call_id: "unfinished" }];
    if (method === "getCall") {
      expect(args).toEqual([{ callId: "unfinished" }]);
      return detail;
    }
    if (method === "getValue") return "actual value bytes";
    throw Error(method);
  });
  const scope = {
    client: {
      call: async () => ({ kind: "durable-object", targetId: "native" }),
      callTarget: dispatch,
    },
  } as unknown as SessionScope;
  await retainNativeSystemTestEvidence(scope, stored);
  expect(loadSystemTestArtifact(stored.runId, "native-evidence", stored.artifactDir)).toMatchObject(
    { complete: true, calls: 1, values: 1 }
  );
  const file = fs.readdirSync(stored.artifactDir).find((name) => name.startsWith("native-call-"))!;
  expect(JSON.parse(fs.readFileSync(path.join(stored.artifactDir, file), "utf8"))).toEqual({
    callId: "unfinished",
    detail,
  });
  expect(loadSystemTestArtifact(stored.runId, `native-value-${hash}`, stored.artifactDir)).toEqual({
    hash,
    value: "actual value bytes",
  });
});
it("attempts every interrupted case and retains unknown inference status when the runner disappeared", async () => {
  const stored = fixture();
  const methods: unknown[][] = [];
  const scope = {
    client: {
      call: async () => {
        throw Error("service unavailable");
      },
      callTarget: async (...args: unknown[]) => {
        methods.push(args);
        throw Error("eval interrupted by restart");
      },
    },
  } as unknown as SessionScope;
  await retainInterruptedRunEvidence(scope, stored, Error("restart"));
  const calls = methods.filter((args) => args[1] === "readSystemTestTrajectoryPage");
  expect(calls).toHaveLength(4);
  expect(loadSystemTestArtifact(stored.runId, "retention", stored.artifactDir)).toMatchObject({
    complete: false,
    inferenceCount: null,
  });
  expect(loadSystemTestArtifact(stored.runId, "interruption", stored.artifactDir)).toMatchObject({
    inferenceCount: null,
  });
  expect(loadSystemTestArtifact(stored.runId, "native-evidence", stored.artifactDir)).toMatchObject(
    { complete: false }
  );
});

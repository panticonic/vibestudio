import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { workerTests } from "./workers.js";

function execution(
  finalMessage: string,
  code?: string,
  returnValue?: unknown,
  evalStatus: "complete" | "error" = "complete"
): TestExecutionResult {
  const messages: TestExecutionResult["messages"] = [
    {
      id: "prompt",
      kind: "message",
      senderId: "user",
      complete: true,
      content: "prompt",
    },
  ] as TestExecutionResult["messages"];
  if (code !== undefined) {
    messages.push({
      id: "call-eval-message",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: "call-eval",
        name: "eval",
        status: evalStatus,
        terminalOutcome: evalStatus === "complete" ? "success" : "tool_error",
        isError: evalStatus !== "complete",
        arguments: { code },
        result: returnValue === undefined ? undefined : { details: { returnValue } },
      },
    } as unknown as TestExecutionResult["messages"][number]);
  }
  messages.push({
    id: "final",
    kind: "message",
    senderId: "agent",
    complete: true,
    content: finalMessage,
  } as TestExecutionResult["messages"][number]);
  return { messages, duration: 0 };
}

function test(name: string) {
  const found = workerTests.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing worker test ${name}`);
  return found;
}

const lifecycleCode = [
  'const before = await rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);',
  'const handle = await rpc.call("main", "runtime.createEntity", [{}]);',
  'const afterCreate = await rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);',
  'await rpc.call("main", "runtime.retireEntity", [{ id: handle.id }]);',
  'const after = await rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);',
].join("\n");

describe("worker test validators", () => {
  it("keeps authored worker probes in an isolated buildable fixture", () => {
    expect(test("worker-do-sql-persistence").workspaceRepoFixture).toEqual({
      kind: "buildable-worker",
      section: "workers",
    });
    expect(test("worker-env").workspaceRepoFixture).toEqual({
      kind: "buildable-worker",
      section: "workers",
    });
  });

  it("requires returned rows for source and live-instance discovery", () => {
    expect(
      test("list-sources").validate(
        execution("Two launchable worker sources are available.", "return workers.listSources();", [
          { source: "workers/a" },
          { source: "workers/b" },
        ])
      ).passed
    ).toBe(true);
    expect(
      test("list-workers").validate(
        execution("There is one running worker instance.", "return workers.list();", [
          { id: "worker-1" },
        ])
      ).passed
    ).toBe(true);
    expect(
      test("list-workers").validate(
        execution("There are no running workers.", "return workers.list();")
      ).passed
    ).toBe(false);
  });

  it("requires an observable Durable Object method result", () => {
    expect(
      test("call-do-method").validate(
        execution(
          "The object reported its current version.",
          'return rpc.call(handle.targetId, "version", []);',
          { version: 3 }
        )
      ).passed
    ).toBe(true);
    expect(
      test("call-do-method").validate(
        execution("The call worked.", 'return rpc.call(handle.targetId, "version", []);')
      ).passed
    ).toBe(false);
  });

  it("accepts natural prose only when SQL, separate object calls, rows, and cleanup agree", () => {
    const code = [
      "const source = `class Probe { write() { this.sql.exec('INSERT INTO rows VALUES (?)', 1); } read() { return this.sql.exec('SELECT * FROM rows').toArray(); } }`;",
      'const handle = await rpc.call("main", "runtime.createEntity", [{}]);',
      'await rpc.call(handle.targetId, "write", []);',
      'await rpc.call(handle.targetId, "read", []);',
      'await rpc.call("main", "runtime.retireEntity", [{ id: handle.id }]);',
    ].join("\n");
    const verified = execution(
      "Both rows were present on the later read, and the disposable object was retired.",
      code,
      { rows: [{ id: 1 }, { id: 2 }], createdId: "worker-1", retiredId: "worker-1" }
    );
    expect(test("worker-do-sql-persistence").validate(verified).passed).toBe(true);

    expect(
      test("worker-do-sql-persistence").validate(
        execution("It persisted two rows and cleaned up.", code, {
          rows: [{ id: 1 }, { id: 2 }],
          createdId: "worker-1",
          retiredId: "worker-2",
        })
      ).passed
    ).toBe(false);
  });

  it("requires the exact retired identity or an identical before/after inventory", () => {
    const prose = "The temporary worker started successfully and was fully removed.";
    expect(
      test("create-destroy").validate(
        execution(prose, lifecycleCode, { createdId: "worker-7", retiredId: "worker-7" })
      ).passed
    ).toBe(true);
    expect(
      test("create-destroy").validate(
        execution(prose, lifecycleCode, { createdId: "worker-7", retiredId: "worker-8" })
      ).passed
    ).toBe(false);
  });

  it("rejects fabricated prose, failed calls, and missing lifecycle operations", () => {
    const prose = "I confirmed that the worker was created and destroyed cleanly.";
    expect(test("create-destroy").validate(execution(prose)).passed).toBe(false);
    expect(
      test("create-destroy").validate(
        execution(prose, lifecycleCode, { before: [], after: [] }, "error")
      ).passed
    ).toBe(false);
    expect(
      test("create-destroy").validate(execution(prose, "return true", { before: [], after: [] }))
        .passed
    ).toBe(false);
  });

  it("requires worker-side observation and matching cleanup identity for environment probes", () => {
    const acceptedOnly = [
      'const handle = await rpc.call("main", "runtime.createEntity", [{ env: { PROBE: "x" } }]);',
      'await rpc.call("main", "runtime.retireEntity", [{ id: handle.id }]);',
    ].join("\n");
    const proof = { observed: "x", createdId: "worker-1", retiredId: "worker-1" };
    expect(
      test("worker-env").validate(
        execution("The worker observed x and was removed.", acceptedOnly, proof)
      ).passed
    ).toBe(false);

    const observed = acceptedOnly.replace(
      'await rpc.call("main", "runtime.retireEntity"',
      'await rpc.call(handle.targetId, "observeConfiguredValue", []);\nawait rpc.call("main", "runtime.retireEntity"'
    );
    expect(
      test("worker-env").validate(
        execution("The worker observed x and was removed.", observed, proof)
      ).passed
    ).toBe(true);
  });
});

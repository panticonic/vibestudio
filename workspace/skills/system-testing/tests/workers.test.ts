import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { workerTests } from "./workers.js";

function execution(
  finalMessage: string,
  code?: string,
  returnValue?: unknown,
  evalStatus: "complete" | "error" = "complete",
  consoleOutput?: string
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
    const details: Record<string, unknown> = {};
    if (returnValue !== undefined) details["returnValue"] = returnValue;
    if (consoleOutput !== undefined) details["console"] = consoleOutput;
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
        result: Object.keys(details).length === 0 ? undefined : { details },
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
  it("keeps launchable-worker discovery vague and independent of API names", () => {
    expect(test("list-sources").prompt).toBe("Which workers can I start here?");
    expect(test("list-sources").prompt).not.toMatch(/listSources|eval|runtime/u);
  });

  it("keeps authored worker probes in an isolated buildable fixture", () => {
    expect(test("worker-do-sql-persistence").workspaceRepoFixture).toEqual({
      kind: "buildable-worker",
      section: "workers",
    });
    expect(test("worker-env").workspaceRepoFixture).toEqual({
      kind: "buildable-regular-worker",
      section: "workers",
    });
    expect(test("dynamic-workspace-service").workspaceRepoFixture).toEqual({
      kind: "buildable-worker",
      section: "workers",
    });
    expect(test("installed-workspace-service-consumer").workspaceRepoFixture).toEqual({
      kind: "buildable-regular-worker",
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
      test("list-sources").validate(
        execution(
          "Two worker sources are available to start.",
          "const units = await workspace.units.list(); return units.filter((unit) => unit.kind === 'worker' && unit.status === 'available');",
          [
            { source: "workers/a", kind: "worker", status: "available" },
            { source: "workers/b", kind: "worker", status: "available" },
          ]
        )
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
    expect(
      test("list-workers").validate(
        execution(
          "No worker unit currently has a running instance.",
          "const units = await workspace.units.list(); return { runningWorkers: units.filter((unit) => unit.kind === 'worker' && unit.status === 'running').length, workers: units.filter((unit) => unit.kind === 'worker') };",
          {
            runningWorkers: 0,
            workers: [
              { name: "@workspace-workers/example", kind: "worker", status: "available" },
            ],
          }
        )
      ).passed
    ).toBe(true);

    expect(
      test("list-sources").validate(
        execution(
          "Twelve launchable workers are available.",
          "const sources = await workers.listSources(); console.log(sources);",
          undefined,
          "complete",
          'sourcesCount 12\n{"source":"workers/agent-worker"}'
        )
      ).passed
    ).toBe(true);
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
        execution("The later resolve returned the same two records and cleanup completed.", code, {
          afterWrite: [{ id: 1 }, { id: 2 }],
          afterReopen: [{ id: 1 }, { id: 2 }],
          persisted: true,
          createdId: "worker-1",
          retiredId: "worker-1",
        })
      ).passed
    ).toBe(true);

    expect(
      test("worker-do-sql-persistence").validate(
        execution("The later resolve did not match.", code, {
          afterReopen: [{ id: 1 }, { id: 2 }],
          persisted: false,
          createdId: "worker-1",
          retiredId: "worker-1",
        })
      ).passed
    ).toBe(false);

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

  it("accepts the documented disposable Durable Object lifecycle", () => {
    const code = [
      "const target = await workers.resolveDurableObject('workers/probe', 'ProbeDO', 'temporary');",
      "await rpc.call(target.targetId, 'write', []);",
      "const rows = await rpc.call(target.targetId, 'read', []);",
      "await workers.destroy(target);",
      "return { rows };",
    ].join("\n");
    expect(
      test("worker-do-sql-persistence").validate(
        execution(
          "The disposable object persisted both rows and was retired.",
          `// this.sql.exec('INSERT INTO rows VALUES (1), (2)'); this.sql.exec('SELECT * FROM rows');\n${code}`,
          { rows: [{ id: 1 }, { id: 2 }] }
        )
      ).passed
    ).toBe(true);
  });

  it("separates authored SQL, runtime persistence, and retirement evidence", () => {
    const result = execution(
      "The disposable object persisted two rows across calls and was retired.",
      [
        "const resolve = () => workers.resolveDurableObject('workers/probe', 'ProbeDO', 'temporary');",
        "const first = await resolve();",
        "await rpc.call(first.targetId, 'seed', []);",
        "const second = await resolve();",
        "await rpc.call(second.targetId, 'read', []);",
        "await workers.destroy(second);",
      ].join("\n"),
      undefined,
      "complete",
      'later rows [\n  { "id": 1 },\n  { "id": 2 }\n]'
    );
    result.messages.splice(1, 0, {
      id: "write-worker",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: "write-worker",
        name: "write",
        status: "complete",
        terminalOutcome: "success",
        isError: false,
        arguments: {
          path: "workers/probe/index.ts",
          content:
            "class ProbeDO { seed() { this.sql.exec('INSERT INTO rows VALUES (1), (2)'); } read() { return this.sql.exec('SELECT * FROM rows').toArray(); } }",
        },
      },
    } as unknown as TestExecutionResult["messages"][number]);
    expect(test("worker-do-sql-persistence").validate(result).passed).toBe(true);
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
    expect(
      test("create-destroy").validate(
        execution(prose, lifecycleCode, {
          before: [{ id: "worker-existing", source: "workers/probe", state: "before" }],
          after: [{ id: "worker-existing", source: "workers/probe", state: "after" }],
        })
      ).passed
    ).toBe(true);
  });

  it("accepts direct lifecycle observation and the documented id form of destroy", () => {
    const code = [
      'const handle = await workers.create("workers/probe", { key: "probe" });',
      "const afterCreate = await workers.list();",
      "await workers.destroy(handle.id);",
      "const after = await workers.list();",
      "return {",
      "  existsAfterCreate: afterCreate.some((entry) => entry.id === handle.id),",
      "  existsAfterDestroy: after.some((entry) => entry.id === handle.id),",
      "};",
    ].join("\n");
    expect(
      test("create-destroy").validate(
        execution("The temporary worker was observed and removed.", code, {
          existsAfterCreate: true,
          existsAfterDestroy: false,
        })
      ).passed
    ).toBe(true);
    expect(
      test("create-destroy").validate(
        execution("The temporary worker remained live.", code, {
          existsAfterCreate: true,
          existsAfterDestroy: true,
        })
      ).passed
    ).toBe(false);
  });

  it("accepts a live-instance count returning to its exact baseline", () => {
    expect(
      test("create-destroy").validate(
        execution(
          "The temporary worker was observed and removed.",
          lifecycleCode,
          { beforeCount: 2, afterCreateCount: 3, afterDestroyCount: 2 }
        )
      ).passed
    ).toBe(true);
    expect(
      test("create-destroy").validate(
        execution(
          "The temporary worker was not fully removed.",
          lifecycleCode,
          { beforeCount: 2, afterCreateCount: 3, afterDestroyCount: 3 }
        )
      ).passed
    ).toBe(false);
  });

  it("accepts an awaited same-eval lifecycle when no redundant cleanup ids are returned", () => {
    expect(
      test("create-destroy").validate(
        execution(
          "The temporary worker was exercised and retired.",
          [
            'const handle = await workers.create("workers/probe", { key: "probe" });',
            "await workers.list();",
            'const result = await rpc.call(handle.targetId, "ping", []);',
            "try { return result; } finally { await workers.destroy(handle); }",
          ].join("\n"),
          { ok: true }
        )
      ).passed
    ).toBe(true);
  });

  it("recognizes an owned handle assigned inside try and retired in finally", () => {
    expect(
      test("create-destroy").validate(
        execution(
          "The temporary worker was exercised and retired.",
          [
            "await workers.list();",
            "let handle = null;",
            "try {",
            '  handle = await workers.create("workers/probe", { key: "probe" });',
            '  await rpc.call(handle.targetId, "ping", []);',
            "} finally {",
            "  if (handle) await workers.destroy(handle);",
            "}",
            "await workers.list();",
          ].join("\n"),
          { ok: true }
        )
      ).passed
    ).toBe(true);
  });

  it("uses a completed same-eval lifecycle when returned observations are incomplete", () => {
    expect(
      test("create-destroy").validate(
        execution(
          "The temporary worker was observed and retired.",
          [
            'const handle = await workers.create("workers/probe", { key: "probe" });',
            "const afterCreate = await workers.list();",
            "await workers.destroy(handle);",
            "const afterRetire = await workers.list();",
            "return {",
            "  beforeCount: 0,",
            "  afterCreateCount: afterCreate.length,",
            "  afterRetireCount: afterRetire.length,",
            "  stillThere: afterRetire.some((entry) => entry.id === handle.id),",
            "};",
          ].join("\n"),
          {
            beforeCount: 0,
            afterCreateCount: 1,
            afterRetireCount: 0,
            stillThere: false,
          }
        )
      ).passed
    ).toBe(true);
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
      'const result = await rpc.call(handle.targetId, "observeConfiguredValue", []);\nawait rpc.call("main", "runtime.retireEntity"'
    );
    expect(
      test("worker-env").validate(
        execution("The worker observed x and was removed.", `${observed}\nreturn result;`, proof)
      ).passed
    ).toBe(true);
    expect(
      test("worker-env").validate(
        execution(
          "The worker observed x and was removed.",
          `${acceptedOnly.replace(
            'await rpc.call("main", "runtime.retireEntity"',
            'let result: unknown = null;\nresult = await rpc.call(handle.targetId, "observeConfiguredValue", []);\nawait rpc.call("main", "runtime.retireEntity"'
          )}\nreturn { result };`,
          proof
        )
      ).passed
    ).toBe(true);
    expect(
      test("worker-env").validate(
        execution(
          "The worker observed x and was removed.",
          `${observed}\nconsole.log({ result });`,
          undefined,
          "complete",
          '{ "result": "x" }'
        )
      ).passed
    ).toBe(true);
    expect(
      test("worker-env").validate(
        execution(
          "The worker observed x and was removed.",
          `${observed}\nconst summary = { probe: result };\nconsole.log(JSON.stringify(summary));`,
          undefined,
          "complete",
          '{ "summary": { "probe": "x" } }'
        )
      ).passed
    ).toBe(true);

    expect(
      test("worker-env").validate(
        execution(
          "The worker was called and removed, but its observation was discarded.",
          observed,
          proof
        )
      ).passed
    ).toBe(false);
  });

  it("requires live discovery, a semantic service declaration, and dynamic invocation", () => {
    const docs = {
      id: "docs-call",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: "docs-call",
        name: "docs_search",
        status: "complete",
        arguments: { query: "workspace service discovery" },
        result: { details: [{ id: "service:workers.resolveService" }] },
      },
    } as unknown as TestExecutionResult["messages"][number];
    const authored = {
      id: "author-call",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: "author-call",
        name: "vcs",
        status: "complete",
        arguments: {
          path: "meta/vibestudio.yml",
          patch:
            "services:\n  - source: workers/probe\nsingletonObjects:\n  - source: workers/probe",
        },
        result: { details: { ok: true } },
      },
    } as unknown as TestExecutionResult["messages"][number];
    const dynamic = execution(
      "The context-local probe answered with its value.",
      'const service = await workers.resolveService("test.probe.v1"); return rpc.call(service.targetId, "report", []);',
      { answer: "context-local" }
    );
    dynamic.messages.splice(1, 0, docs, authored);
    expect(test("dynamic-workspace-service").validate(dynamic).passed).toBe(true);

    const typedAuthored = {
      ...authored,
      invocation: {
        ...((authored as unknown as { invocation: object }).invocation as object),
        id: "workspace-service-call",
        name: "workspace_service",
        arguments: {
          operation: "upsert",
          name: "probe",
          source: "workers/probe",
          protocols: ["test.probe.v1"],
        },
      },
    } as unknown as TestExecutionResult["messages"][number];
    const typed = execution(
      "The context-local probe answered with its value.",
      'const service = await workers.resolveService("test.probe.v1"); return rpc.call(service.targetId, "report", []);',
      { answer: "context-local" }
    );
    typed.messages.splice(1, 0, docs, typedAuthored);
    expect(test("dynamic-workspace-service").validate(typed).passed).toBe(true);

    const noDocs = execution(
      "The context-local probe answered with its value.",
      'const service = await workers.resolveService("test.probe.v1"); return rpc.call(service.targetId, "report", []);',
      { answer: "context-local" }
    );
    noDocs.messages.splice(1, 0, authored);
    expect(test("dynamic-workspace-service").validate(noDocs).passed).toBe(false);

    const catalog = execution(
      "The context-local probe answered with its value.",
      'const service = await workers.resolveService("test.probe.v1"); return rpc.call(service.targetId, "report", []);',
      { answer: "context-local" }
    );
    catalog.messages.splice(1, 0, docs, authored, {
      ...authored,
      invocation: {
        ...((authored as unknown as { invocation: object }).invocation as object),
        id: "catalog-call",
        arguments: { path: "generated/productAuthorityGrantCatalog.ts" },
      },
    } as unknown as TestExecutionResult["messages"][number]);
    expect(test("dynamic-workspace-service").validate(catalog).passed).toBe(false);
  });

  it("requires installed consumers to request an exact dynamic service and execute it", () => {
    const calls = [
      {
        id: "docs",
        name: "docs_search",
        status: "complete",
        arguments: { query: "workspace services" },
        result: { details: [{ id: "service:workers.resolveService" }] },
      },
      {
        id: "manifest",
        name: "edit",
        status: "complete",
        arguments: {
          path: "workers/probe/package.json",
          patch: '"capability": "workspace-service:probe.local"',
        },
        result: { details: { ok: true } },
      },
      {
        id: "consumer",
        name: "edit",
        status: "complete",
        arguments: {
          path: "workers/probe/index.ts",
          patch: 'const service = await runtime.workers.resolveService("vibestudio.models.v1");',
        },
        result: { details: { ok: true } },
      },
    ].map(
      (invocation) =>
        ({
          id: invocation.id,
          kind: "message",
          senderId: "agent",
          complete: true,
          contentType: "invocation",
          content: "",
          invocation,
        }) as unknown as TestExecutionResult["messages"][number]
    );
    const result = execution(
      "The installed consumer observed the local service and was retired.",
      [
        'const handle = await workers.create("workers/probe", { key: "installed-probe" });',
        'const observed = await rpc.call(handle.targetId, "consumeLocalService", []);',
        "await workers.destroy(handle);",
      ].join("\n"),
      { observed: { answer: "local" }, createdId: "worker-1", retiredId: "worker-1" }
    );
    result.messages.splice(1, 0, ...calls);
    expect(test("installed-workspace-service-consumer").validate(result).passed).toBe(true);

    const publicId = structuredClone(result);
    const evalMessage = publicId.messages.find(
      (message) => message.kind === "message" && message.invocation?.id === "call-eval"
    );
    if (evalMessage?.kind === "message" && evalMessage.invocation) {
      evalMessage.invocation.arguments = {
        code: [
          'const worker = await workers.create("workers/probe", { key: "installed-probe" });',
          'const observed = await rpc.call(worker.id, "consumeTestkitService", []);',
          "await workers.destroy(worker);",
        ].join("\n"),
      };
    }
    expect(test("installed-workspace-service-consumer").validate(publicId).passed).toBe(true);

    const unrelatedTarget = structuredClone(result);
    const unrelatedEval = unrelatedTarget.messages.find(
      (message) => message.kind === "message" && message.invocation?.id === "call-eval"
    );
    if (unrelatedEval?.kind === "message" && unrelatedEval.invocation) {
      unrelatedEval.invocation.arguments = {
        code: [
          'const handle = await workers.create("workers/probe", { key: "installed-probe" });',
          'const observed = await rpc.call(other.id, "consumeLocalService", []);',
          "await workers.destroy(handle);",
        ].join("\n"),
      };
    }
    expect(test("installed-workspace-service-consumer").validate(unrelatedTarget).passed).toBe(
      false
    );

    const wildcard = structuredClone(result);
    const manifest = wildcard.messages.find(
      (message) => message.kind === "message" && message.invocation?.id === "manifest"
    );
    if (manifest?.kind === "message" && manifest.invocation) {
      manifest.invocation.arguments = {
        path: "workers/probe/package.json",
        patch: '"capability": "workspace-service:*"',
      };
    }
    expect(test("installed-workspace-service-consumer").validate(wildcard).passed).toBe(false);
  });
});

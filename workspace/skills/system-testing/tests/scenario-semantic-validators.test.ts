import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";
import { evalLifecycleTests } from "./eval-lifecycle.js";
import { extensionSurfaceTests } from "./extensions-surface.js";
import { filesystemTests } from "./filesystem.js";
import { multiUserTests } from "./multi-user.js";
import { workerTests } from "./workers.js";
import { workspaceTests } from "./workspace.js";
import { completedScenarioEvidence } from "./_scenario-evidence.js";

interface EvalStep {
  code: string;
  imports?: Record<string, string>;
  returnValue?: unknown;
  kernelIncarnationId?: string;
  reset?: boolean;
  status?: "complete" | "error" | "cancelled";
  result?: unknown;
  authority?: Record<string, unknown>;
}

interface ToolStep {
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

function execution(finalMessage: string, steps: EvalStep[]): TestExecutionResult {
  const messages: TestExecutionResult["messages"] = [
    {
      id: "prompt",
      kind: "message",
      senderId: "user",
      complete: true,
      content: "prompt",
    },
  ] as TestExecutionResult["messages"];
  steps.forEach((step, index) => {
    const status = step.status ?? "complete";
    messages.push({
      id: `eval-message-${index}`,
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: `eval-${index}`,
        name: "eval",
        status,
        terminalOutcome:
          status === "complete" ? "success" : status === "cancelled" ? "cancelled" : "tool_error",
        isError: status !== "complete",
        arguments: {
          code: step.code,
          ...(step.imports === undefined ? {} : { imports: step.imports }),
          ...(step.reset === undefined ? {} : { reset: step.reset }),
          ...(step.authority === undefined ? {} : { authority: step.authority }),
        },
        result:
          step.result ??
          (step.returnValue === undefined
            ? undefined
            : {
                details: {
                  returnValue: step.returnValue,
                  ...(step.kernelIncarnationId
                    ? { kernel: { incarnationId: step.kernelIncarnationId } }
                    : {}),
                },
              }),
      },
    } as unknown as TestExecutionResult["messages"][number]);
  });
  messages.push({
    id: "final",
    kind: "message",
    senderId: "agent",
    complete: true,
    content: finalMessage,
  } as TestExecutionResult["messages"][number]);
  return { duration: 0, messages };
}

function directExecution(finalMessage: string, steps: ToolStep[]): TestExecutionResult {
  const result = execution(finalMessage, []);
  result.messages.splice(
    1,
    0,
    ...steps.map(
      (step, index) =>
        ({
          id: `tool-${index}`,
          kind: "message",
          senderId: "agent",
          complete: true,
          contentType: "invocation",
          content: "",
          invocation: {
            id: `tool-${index}`,
            name: step.name,
            status: "complete",
            terminalOutcome: "success",
            isError: false,
            arguments: step.arguments ?? {},
            result: step.result,
          },
        }) as unknown as TestExecutionResult["messages"][number]
    )
  );
  return result;
}

function scenario(tests: { name: string }[], name: string) {
  const found = tests.find((candidate) => candidate.name === name);
  if (!found || !("validate" in found)) throw new Error(`Missing scenario ${name}`);
  return found as (typeof filesystemTests)[number];
}

describe("scenario tool protocol semantics", () => {
  it("keeps pre-execution argument rejections diagnostic without calling them failed effects", () => {
    const result = execution("I corrected the call and completed the task.", []);
    result.messages.splice(1, 0, {
      id: "rejected",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "tool failed",
      invocation: {
        id: "rejected-edit",
        name: "edit",
        status: "error",
        terminalOutcome: "tool_error",
        isError: true,
        error: "Invalid arguments for tool edit: /newText: Expected required property",
      },
    } as unknown as TestExecutionResult["messages"][number]);

    expect(completedScenarioEvidence(result, [])).toMatchObject({ passed: true });
  });
});

describe("eval authority lifecycle validators", () => {
  const permissionsRead = {
    capability: "permissions.read",
    resource: { kind: "exact", key: "permissions.read" },
  };

  it("requires the exact request allowlist and structured result", () => {
    const validator = scenario(evalLifecycleTests, "eval-exact-authority");
    expect(
      validator.validate(
        execution("Read permissions.", [
          {
            code: "return await services.permissions.list();",
            authority: {
              effects: "read-only",
              approvals: "pregranted-only",
              requests: [permissionsRead],
            },
            returnValue: [],
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      validator.validate(
        execution("Read permissions.", [
          {
            code: "return await services.permissions.list();",
            authority: { effects: "read-only", approvals: "pregranted-only" },
            returnValue: [],
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("requires an empty pregranted-only manifest and a structured denial", () => {
    const validator = scenario(evalLifecycleTests, "eval-pregranted-only");
    expect(
      validator.validate(
        execution("The operation was denied without requesting approval.", [
          {
            code: "try { await services.permissions.list(); } catch (error) { return { denied: true, message: String(error) }; }",
            authority: { requests: [], approvals: "pregranted-only" },
            returnValue: { denied: true, message: "authority denied" },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      validator.validate(
        execution("The operation was denied.", [
          {
            code: "return { denied: true, message: 'authority denied' };",
            authority: { approvals: "pregranted-only", requests: [permissionsRead] },
            returnValue: { denied: true, message: "authority denied" },
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("binds preauthorization to the exact invocation arguments", () => {
    const validator = scenario(evalLifecycleTests, "eval-preauthorization");
    expect(
      validator.validate(
        execution("Read permissions.", [
          {
            code: "return await services.permissions.list();",
            authority: {
              approvals: "prompt",
              preauthorize: [{ service: "permissions", method: "list", args: [] }],
            },
            returnValue: [],
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      validator.validate(
        execution("Read permissions.", [
          {
            code: "return await services.permissions.list();",
            authority: {
              approvals: "prompt",
              preauthorize: [{ service: "permissions", method: "list", args: [{ widened: true }] }],
            },
            returnValue: [],
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("requires stable ordered cursor pages instead of a prose event claim", () => {
    const validator = scenario(evalLifecycleTests, "eval-events");
    const page = { events: [{ sequence: 1, kind: "state" }], next: 1, hasMore: true };
    const finalPage = { events: [{ sequence: 2, kind: "console" }], next: 2, hasMore: false };
    expect(
      validator.validate({
        messages: [],
        duration: 0,
        diagnostics: {
          evalEventPages: {
            terminal: { status: "done", result: { success: true } },
            firstPage: page,
            repeatedFirstPage: page,
            pages: [page, finalPage],
          },
        },
      }).passed
    ).toBe(true);
    expect(
      validator.validate({
        messages: [],
        duration: 0,
        diagnostics: {
          evalEventPages: {
            terminal: { status: "done", result: { success: true } },
            firstPage: page,
            repeatedFirstPage: { ...page, next: 2 },
            pages: [page, finalPage],
          },
        },
      }).passed
    ).toBe(false);
  });
});

describe("filesystem semantic validators", () => {
  const cases = [
    ["read-write-text", "fs.writeFile(); fs.readFile();", { written: "alpha", read: "alpha" }],
    [
      "read-write-binary",
      "fs.writeFile(); fs.readFile();",
      { written: [1, 2, 3], read: [1, 2, 3] },
    ],
    ["append-file", "fs.writeFile(); fs.appendFile(); fs.readFile();", "first\nsecond"],
    ["directory-ops", "fs.mkdir(); fs.readdir();", ["one.txt", "two.txt"]],
    ["file-stats", "fs.writeFile(); fs.stat();", { size: 5, mtimeMs: 123 }],
    ["rename-copy", "fs.copyFile(); fs.readFile();", { source: "same", destination: "same" }],
    ["remove", "fs.mkdir(); fs.rm();", { exists: false }],
    ["symlinks", "fs.symlink(); fs.readlink();", { supported: true }],
    [
      "file-handles",
      "const handle = fs.open(); await handle.close();",
      { written: "through-handle", read: "through-handle" },
    ],
  ] as const;

  for (const [name, code, returnValue] of cases) {
    it(`accepts canonical ${name} evidence with ordinary prose`, () => {
      const validator = scenario(filesystemTests, name);
      expect(
        validator.validate(
          execution("I verified the temporary filesystem operation and cleaned up.", [
            { code, returnValue },
          ])
        ).passed
      ).toBe(true);
      expect(validator.validate(execution("Everything worked perfectly.", [])).passed).toBe(false);
    });
  }

  it("accepts equivalent named imports from the scoped Node filesystem facade", () => {
    const validator = scenario(filesystemTests, "directory-ops");
    expect(
      validator.validate(
        execution("I created, listed, and removed the temporary directory.", [
          {
            code: `
              import { mkdir, readdir as list, rm } from "fs/promises";
              await mkdir(".tmp/example");
              const files = await list(".tmp/example");
              await rm(".tmp/example", { recursive: true });
              return files;
            `,
            returnValue: ["one.txt", "two.txt"],
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts focused write/read tools as first-class scratch filesystem evidence", () => {
    const validator = scenario(filesystemTests, "read-write-text");
    expect(
      validator.validate(
        directExecution("The text round trip matched exactly.", [
          {
            name: "write",
            arguments: { path: ".tmp/example.txt", content: "same text" },
            result: { details: { bytesWritten: 9, storage: "scratch" } },
          },
          {
            name: "read",
            arguments: { path: ".tmp/example.txt" },
            result: { protocolContent: [{ type: "text", text: "same text" }] },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts focused nested writes and a structured listing as directory evidence", () => {
    const validator = scenario(filesystemTests, "directory-ops");
    expect(
      validator.validate(
        directExecution("The nested directory contains exactly the two files I wrote.", [
          {
            name: "write",
            arguments: { path: ".tmp/example/one.txt", content: "one" },
            result: { details: { bytesWritten: 3, storage: "scratch" } },
          },
          {
            name: "write",
            arguments: { path: ".tmp/example/two.txt", content: "two" },
            result: { details: { bytesWritten: 3, storage: "scratch" } },
          },
          {
            name: "ls",
            arguments: { path: ".tmp/example" },
            result: {
              protocolContent: [{ type: "text", text: "one.txt\ntwo.txt" }],
              details: { path: ".tmp/example", entries: ["one.txt", "two.txt"] },
            },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts focused scratch copy/read evidence without pretending it exercised eval", () => {
    const validator = scenario(filesystemTests, "rename-copy");
    expect(
      validator.validate(
        directExecution("The copied content matched.", [
          {
            name: "write",
            arguments: { path: ".tmp/source.txt", content: "same text" },
            result: { details: { bytesWritten: 9, storage: "scratch" } },
          },
          {
            name: "copy_file",
            arguments: {
              source: ".tmp/source.txt",
              destination: ".tmp/destination.txt",
            },
            result: { details: { operation: "copied", storage: "scratch" } },
          },
          {
            name: "read",
            arguments: { path: ".tmp/destination.txt" },
            result: { protocolContent: [{ type: "text", text: "same text" }] },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("does not accept text-only focused tools as binary filesystem evidence", () => {
    const validator = scenario(filesystemTests, "read-write-binary");
    expect(
      validator.validate(
        directExecution("The text matched.", [
          {
            name: "write",
            arguments: { path: ".tmp/example.txt", content: "same text" },
          },
          {
            name: "read",
            arguments: { path: ".tmp/example.txt" },
            result: { protocolContent: [{ type: "text", text: "same text" }] },
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("does not misclassify a managed VCS write as scratch filesystem evidence", () => {
    const validator = scenario(filesystemTests, "read-write-text");
    expect(
      validator.validate(
        directExecution("The managed file content matched.", [
          {
            name: "write",
            arguments: { path: "projects/example/file.txt", content: "same text" },
            result: { details: { bytesWritten: 9, storage: "vcs" } },
          },
          {
            name: "read",
            arguments: { path: "projects/example/file.txt" },
            result: { protocolContent: [{ type: "text", text: "same text" }] },
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("accepts post-removal proof preserved in structured tool result content", () => {
    const validator = scenario(filesystemTests, "remove");
    expect(
      validator.validate(
        execution("I verified the directory no longer exists.", [
          {
            code: "await fs.mkdir(path); await fs.rm(path); return { baseExistsAfter: false };",
            result: {
              protocolContent: [
                { type: "text", text: '{"baseExistsAfter": false, "treeExistsAfter": false}' },
              ],
            },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts a concrete symbolic-link observation without a synthetic supported field", () => {
    const validator = scenario(filesystemTests, "symlinks");
    expect(
      validator.validate(
        execution("The link identified itself as symbolic.", [
          {
            code: "await fs.symlink(target, link); return { isSym: (await fs.lstat(link)).isSymbolicLink() };",
            result: {
              protocolContent: [{ type: "text", text: '{"isSym": true}' }],
            },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts concrete readlink and realpath observations nested in a probe report", () => {
    const validator = scenario(filesystemTests, "symlinks");
    expect(
      validator.validate(
        execution("Scratch symbolic links are supported and resolve inside the context.", [
          {
            code: "await fs.symlink(target, link); await fs.readlink(link); return report;",
            returnValue: {
              steps: [
                {
                  result: {
                    linkPath: "/.tmp/example/link.txt",
                    readlink: "target.txt",
                    realpath: "/.tmp/example/target.txt",
                  },
                },
              ],
            },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("does not treat the final prose claim as filesystem effect evidence", () => {
    const validator = scenario(filesystemTests, "remove");
    expect(
      validator.validate(
        execution("Verified existsAfterDir: false.", [
          { code: "await fs.mkdir(path); await fs.rm(path);" },
        ])
      ).passed
    ).toBe(false);
  });

  it("accepts explicit post-removal existence evidence", () => {
    const validator = scenario(filesystemTests, "remove");
    expect(
      validator.validate(
        execution("I verified the directory no longer exists.", [
          {
            code: "await fs.mkdir(path); await fs.rm(path); return { existsAfterDir: false };",
            returnValue: { existsAfterDir: false },
          },
        ])
      ).passed
    ).toBe(true);
  });
});

describe("build semantic validators", () => {
  it("requires canonical build artifacts and metadata", () => {
    const result = execution("The selected UI unit built successfully with one output artifact.", [
      {
        code: "return services.build.getBuild('panels/app');",
        returnValue: {
          dir: "/virtual/build/panels/app",
          artifacts: ["index.js"],
          metadata: { kind: "panel" },
        },
      },
    ]);
    expect(scenario(buildTests, "build-workspace-package").validate(result).passed).toBe(true);
    expect(
      scenario(buildTests, "build-workspace-package").validate(
        execution("The build report completed successfully.", [
          {
            code: "return services.build.getBuildReport('panels/app');",
            returnValue: { unit: "@workspace-panels/app", status: "ok", success: true },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(buildTests, "build-workspace-package").validate(
        execution("The build succeeded.", [
          { code: "return services.build.getBuild('panels/app');", returnValue: { ok: true } },
        ])
      ).passed
    ).toBe(false);
  });

  it("ties workspace import evidence to the invocation that returned exports", () => {
    const result = execution("The package exports a ready function and its version.", [
      {
        code: "import * as unit from '@workspace/example'; return Object.keys(unit);",
        imports: { "@workspace/example": "workspace:*" },
        returnValue: ["ready", "version"],
      },
    ]);
    expect(scenario(buildTests, "import-built-package").validate(result).passed).toBe(true);
    expect(
      scenario(buildTests, "import-built-package").validate(
        execution("The package exports a ready function and its version.", [
          {
            code: "import * as unit from '@workspace-skills/workspace-dev'; return Object.keys(unit);",
            returnValue: ["ready", "version"],
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(buildTests, "import-built-package").validate(
        execution("The package exports a ready function and its version.", [
          {
            code: "const unit = await import('@workspace-skills/workspace-dev'); return Object.keys(unit);",
            returnValue: ["ready", "version"],
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(buildTests, "import-built-package").validate(
        execution("The package had useful exports.", [
          {
            code: "import * as unit from '@workspace/example'; return undefined;",
            imports: { "@workspace/example": "workspace:*" },
          },
          { code: "return ['unrelated'];", returnValue: ["unrelated"] },
        ])
      ).passed
    ).toBe(false);
  });
});

describe("workspace semantic validators", () => {
  it("derives catalog, active identity, and configuration facts from completed results", () => {
    expect(
      scenario(workspaceTests, "list-workspace-units").validate(
        execution("The catalog contains the current panel and worker units.", [
          { code: "return build.listUnits();", returnValue: [{ id: "panel-1" }] },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(workspaceTests, "get-active").validate(
        execution("The active workspace is the development workspace.", [
          { code: "return workspace.getActive();", returnValue: "development" },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(workspaceTests, "get-config").validate(
        execution("The workspace uses a local origin and main context.", [
          {
            code: "return workspace.getInfo();",
            returnValue: { origin: "local", context: "main" },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("rejects prose and empty structured results", () => {
    expect(
      scenario(workspaceTests, "get-config").validate(
        execution("It has a rich and valid configuration.", [
          { code: "return workspace.getInfo();", returnValue: {} },
        ])
      ).passed
    ).toBe(false);
  });
});

describe("multi-user semantic validators", () => {
  it("accepts a live account profile whose durable identity is a handle", () => {
    const validator = scenario(multiUserTests, "account-whoami");
    expect(
      validator.validate(
        execution("This session is acting as root.", [
          {
            code: "return await services.account.getProfile();",
            returnValue: { handle: "root" },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("accepts the observed channel types without requiring a fictional human", () => {
    const validator = scenario(multiUserTests, "channel-roster-identity");
    expect(
      validator.validate(
        execution("There are 2 participants: one agent and one headless participant.", [
          {
            code: "return await services.gad.inspectChannelRoster();",
            returnValue: [
              { participantId: "agent-1", type: "agent" },
              { participantId: "runner-1", type: "headless" },
            ],
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("rejects a roster summary that omits a returned participant type", () => {
    const validator = scenario(multiUserTests, "channel-roster-identity");
    expect(
      validator.validate(
        execution("There are 2 agent participants.", [
          {
            code: "return await chat.getParticipants();",
            returnValue: [
              { participantId: "agent-1", type: "agent" },
              { participantId: "runner-1", type: "headless" },
            ],
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("rejects treating a headless client as an agent", () => {
    const validator = scenario(multiUserTests, "channel-roster-identity");
    expect(
      validator.validate(
        execution("The agent and headless participants mean all participants are agents.", [
          {
            code: "return await chat.getParticipants();",
            returnValue: [
              { id: "agent-1", name: "AI Chat", type: "agent", isAgent: true, isPerson: false },
              {
                id: "runner-1",
                name: "Headless Client",
                type: "headless",
                isAgent: false,
                isPerson: false,
              },
            ],
          },
        ])
      ).passed
    ).toBe(false);
  });
});

describe("eval lifecycle semantic validators", () => {
  it("requires invoking the same live scope method without reconstructing it", () => {
    const result = execution("The same live method remained callable after the idle boundary.", [
      {
        code: "scope.__kernelContinuityProbe = { ping: () => 'LIVE_KERNEL_OK' }; return { methodType: typeof scope.__kernelContinuityProbe.ping };",
        returnValue: { methodType: "function" },
        kernelIncarnationId: "kernel-1",
      },
      {
        code: "const probe = scope.__kernelContinuityProbe as any; return { methodType: typeof probe.ping, value: probe.ping() };",
        returnValue: { methodType: "function", value: "LIVE_KERNEL_OK" },
        kernelIncarnationId: "kernel-1",
      },
    ]);
    const validator = scenario(evalLifecycleTests, "eval-live-kernel-continuity");
    expect(validator.validate(result).passed).toBe(true);
    expect(
      validator.validate(
        execution("I recreated it.", [
          {
            code: "scope.__kernelContinuityProbe = { ping: () => 'LIVE_KERNEL_OK' }; return true;",
            returnValue: true,
            kernelIncarnationId: "kernel-1",
          },
          {
            code: "scope.__kernelContinuityProbe = { ping: () => 'LIVE_KERNEL_OK' }; return { methodType: 'function', value: scope.__kernelContinuityProbe.ping() };",
            returnValue: { methodType: "function", value: "LIVE_KERNEL_OK" },
            kernelIncarnationId: "kernel-1",
          },
        ])
      ).passed
    ).toBe(false);
    expect(
      validator.validate(
        execution("It was reconstructed.", [
          {
            code: "scope.__kernelContinuityProbe = { ping: () => 'LIVE_KERNEL_OK' }; return true;",
            returnValue: true,
            kernelIncarnationId: "kernel-1",
          },
          {
            code: "const probe = scope.__kernelContinuityProbe; return { methodType: typeof probe.ping, value: probe.ping() };",
            returnValue: { methodType: "function", value: "LIVE_KERNEL_OK" },
            kernelIncarnationId: "kernel-2",
          },
        ])
      ).passed
    ).toBe(false);
  });

  it("requires database writes and later reads in distinct completed evals", () => {
    const result = execution("The later query returned both rows from the earlier evaluation.", [
      {
        code: "db.run('CREATE TABLE rows (id INTEGER)'); db.run('INSERT INTO rows VALUES (1), (2)'); return { inserted: 2 };",
        returnValue: { inserted: 2 },
      },
      {
        code: "return db.exec('SELECT * FROM rows');",
        returnValue: [{ id: 1 }, { id: 2 }],
      },
    ]);
    expect(scenario(evalLifecycleTests, "eval-db-persistence").validate(result).passed).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-db-persistence").validate(
        execution("The later query returned the one row from the earlier evaluation.", [
          {
            code: "db.run('CREATE TABLE rows (id INTEGER)'); db.run('INSERT INTO rows VALUES (1)'); return { inserted: 1 };",
            returnValue: { inserted: 1 },
          },
          {
            code: "return { rows: db.exec('SELECT * FROM rows') };",
            returnValue: { rows: [{ id: 1 }] },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-db-persistence").validate(
        execution("The row written through db.exec remained available later.", [
          {
            code: "db.exec('CREATE TABLE rows (id INTEGER)'); db.exec('INSERT INTO rows VALUES (1)'); return { inserted: 1 };",
            returnValue: { inserted: 1 },
          },
          {
            code: "return { rows: db.exec('SELECT * FROM rows') };",
            returnValue: { rows: [{ id: 1 }] },
          },
        ])
      ).passed
    ).toBe(true);
  });

  it("requires an actual reset boundary after a separate scope confirmation", () => {
    const result = execution("The value survived one evaluation, then was absent after reset.", [
      { code: "scope.probe = 'retained'; return scope.probe;", returnValue: "retained" },
      { code: "return scope.probe;", returnValue: "retained" },
      {
        code: "return { fresh: scope.probe === undefined };",
        reset: true,
        returnValue: { fresh: true },
      },
    ]);
    expect(scenario(evalLifecycleTests, "eval-scope-reset").validate(result).passed).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-scope-reset").validate(
        execution("A clean baseline was established, then the later reset removed the value.", [
          {
            code: "scope.probe = 'retained'; return scope.probe;",
            reset: true,
            returnValue: "retained",
          },
          { code: "return scope.probe;", returnValue: "retained" },
          {
            code: "return { oldValue: scope.probe ?? null };",
            reset: true,
            returnValue: { oldValue: null },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-scope-reset").validate(
        execution("I reset it and the value was gone.", [
          { code: "return { fresh: true };", returnValue: { fresh: true } },
        ])
      ).passed
    ).toBe(false);
  });

  it("accepts one terminal cancellation and rejects cancellation prose alone", () => {
    const cancelled: TestExecutionResult = {
      duration: 0,
      messages: [],
      diagnostics: {
        evalCancellation: {
          runId: "run-1",
          cancel: { ok: true, forcedReset: false },
          terminal: { status: "cancelled" },
        },
      },
    };
    expect(scenario(evalLifecycleTests, "eval-cancel-run").validate(cancelled).passed).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-cancel-run").validate(
        execution("The long run was cancelled.", [])
      ).passed
    ).toBe(false);
  });

  it("requires one original eval result after an observed live vessel abort", () => {
    const validator = scenario(evalLifecycleTests, "eval-agent-replay");
    const recovered = execution("The durable eval returned once.", [
      {
        code: 'return { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 1 };',
        returnValue: { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 1 },
      },
    ]);
    recovered.diagnostics = {
      evalAgentReplay: {
        targetId: "do:workers/agent-worker:AiChatWorker:agent-1",
        invocationId: "eval-0",
        statusBeforeAbort: "running",
        aborted: true,
      },
    };
    expect(validator.validate(recovered).passed).toBe(true);

    const duplicate = execution("It ran twice.", [
      {
        code: 'return { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 1 };',
        returnValue: { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 1 },
      },
      {
        code: 'return { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 2 };',
        returnValue: { marker: "EVAL_AGENT_REPLAY_OK", completionCount: 2 },
      },
    ]);
    duplicate.diagnostics = recovered.diagnostics;
    expect(validator.validate(duplicate).passed).toBe(false);
  });
});

describe("extension semantic validators", () => {
  it("requires registry rows for extension discovery", () => {
    const result = execution("Two workspace extensions are currently available.", [
      {
        code: "return (await build.listUnits()).filter((unit) => unit.kind === 'extension');",
        returnValue: [{ name: "typecheck" }, { name: "test-runner" }],
      },
    ]);
    expect(scenario(extensionSurfaceTests, "extension-list").validate(result).passed).toBe(true);
  });

  it("requires diagnostics returned by the typecheck extension", () => {
    const result = execution("The selected unit type-checks without diagnostics.", [
      {
        code: 'return services.extensions.invoke("@workspace-extensions/typecheck-service", "checkPanel", ["panels/app"]);',
        returnValue: { diagnostics: [], success: true },
      },
    ]);
    expect(
      scenario(extensionSurfaceTests, "extension-typecheck-unit").validate(result).passed
    ).toBe(true);
  });

  it("joins registry discovery and a successful structured invocation", () => {
    const result = execution("The read-only method returned a structured status record.", [
      {
        code: "const entries = (await build.listUnits()).filter((unit) => unit.kind === 'extension'); return { entries, value: await services.extensions.invoke(entries[0].name, \"status\", []) };",
        returnValue: { entries: [{ name: "probe" }], value: { status: "ready" } },
      },
    ]);
    expect(
      scenario(extensionSurfaceTests, "extension-invoke-roundtrip").validate(result).passed
    ).toBe(true);
  });
});

describe("scenario prompts", () => {
  it("use vague user goals without marker protocols or answer templates", () => {
    const tests = [
      ...buildTests,
      ...filesystemTests,
      ...workspaceTests,
      ...evalLifecycleTests,
      ...extensionSurfaceTests,
      ...workerTests,
    ];
    for (const test of tests) {
      expect(test.prompt).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u);
      expect(test.prompt).not.toMatch(/finish with|respond with|report .*:\s*</iu);
    }
  });
});

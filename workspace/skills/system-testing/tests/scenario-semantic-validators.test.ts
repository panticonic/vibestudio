import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";
import { evalLifecycleTests } from "./eval-lifecycle.js";
import { extensionSurfaceTests } from "./extensions-surface.js";
import { filesystemTests } from "./filesystem.js";
import { workerTests } from "./workers.js";
import { workspaceTests } from "./workspace.js";
import { completedScenarioEvidence } from "./_scenario-evidence.js";

interface EvalStep {
  code: string;
  imports?: Record<string, string>;
  returnValue?: unknown;
  reset?: boolean;
  status?: "complete" | "error" | "cancelled";
  result?: unknown;
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
        },
        result:
          step.result ??
          (step.returnValue === undefined
            ? undefined
            : { details: { returnValue: step.returnValue } }),
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

describe("filesystem semantic validators", () => {
  const cases = [
    [
      "read-write-text",
      "fs.writeFile(); fs.readFile(); fs.rm();",
      { written: "alpha", read: "alpha" },
    ],
    [
      "read-write-binary",
      "fs.writeFile(); fs.readFile(); fs.rm();",
      { written: [1, 2, 3], read: [1, 2, 3] },
    ],
    ["append-file", "fs.writeFile(); fs.appendFile(); fs.readFile(); fs.rm();", "first\nsecond"],
    ["directory-ops", "fs.mkdir(); fs.readdir(); fs.rm();", ["one.txt", "two.txt"]],
    ["file-stats", "fs.writeFile(); fs.stat(); fs.rm();", { size: 5, mtimeMs: 123 }],
    [
      "rename-copy",
      "fs.copyFile(); fs.readFile(); fs.rm();",
      { source: "same", destination: "same" },
    ],
    ["remove", "fs.mkdir(); fs.rm();", { exists: false }],
    ["symlinks", "fs.symlink(); fs.readlink(); fs.rm();", { supported: true }],
    [
      "file-handles",
      "const handle = fs.open(); await handle.close(); fs.rm();",
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

  it("accepts focused write/read tools as first-class filesystem evidence", () => {
    const validator = scenario(filesystemTests, "read-write-text");
    expect(
      validator.validate(
        directExecution("The text round trip matched exactly.", [
          {
            name: "write",
            arguments: { path: ".tmp/example.txt", content: "same text" },
            result: { details: { bytesWritten: 9 } },
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

  it("accepts post-removal proof preserved in the user-visible result text", () => {
    const validator = scenario(filesystemTests, "remove");
    expect(
      validator.validate(
        execution("Verified baseExistsAfter: false.", [
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

  it("accepts concrete symbolic-link observations without a synthetic supported field", () => {
    const validator = scenario(filesystemTests, "symlinks");
    expect(
      validator.validate(
        execution("Temporary symbolic links are supported; isSymbolicLink() was true.", [
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
      scenario(workspaceTests, "list-workspaces").validate(
        execution("The catalog contains the current panel and worker units.", [
          { code: "return workspace.units.list();", returnValue: [{ id: "panel-1" }] },
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
            code: "return workspace.getConfig();",
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
          { code: "return workspace.getConfig();", returnValue: {} },
        ])
      ).passed
    ).toBe(false);
  });
});

describe("eval lifecycle semantic validators", () => {
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
        execution("I reset it and the value was gone.", [
          { code: "return { fresh: true };", returnValue: { fresh: true } },
        ])
      ).passed
    ).toBe(false);
  });

  it("accepts one terminal cancellation and rejects cancellation prose alone", () => {
    const cancelled = execution("The long run reached a cancelled terminal state.", [
      {
        code: "await new Promise(() => {});",
        status: "cancelled",
        result: { message: "run cancelled by caller" },
      },
    ]);
    expect(scenario(evalLifecycleTests, "eval-cancel-run").validate(cancelled).passed).toBe(true);
    expect(
      scenario(evalLifecycleTests, "eval-cancel-run").validate(
        execution("The long run was cancelled.", [])
      ).passed
    ).toBe(false);
  });
});

describe("extension semantic validators", () => {
  it("requires registry rows for extension discovery", () => {
    const result = execution("Two workspace extensions are currently available.", [
      {
        code: 'return rpc.call("main", "extensions.list", []);',
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
        code: 'const entries = await rpc.call("main", "extensions.list", []); return { entries, value: await services.extensions.invoke(entries[0].name, "status", []) };',
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

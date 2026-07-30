import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartVitest = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    state: { getTestModules: () => [] },
    close: vi.fn(),
  })
);

vi.mock("vitest/node", () => ({
  startVitest: mockStartVitest,
}));

import { activate } from "./index.js";

interface CallerInfo {
  callerId?: string;
  callerKind?: string;
  contextId?: string;
  chainContextId?: string;
}

function makeWorkspace() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-test-runner-source-"));
  const contextProjections = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibestudio-test-runner-context-projections-")
  );
  return { source, contextProjections };
}

function makeCtx(workspace = makeWorkspace(), caller: CallerInfo = {}) {
  const ensureMaterialized = vi.fn(async (_scope: string | string[] | "all") => {});
  const ctx = {
    workspace: {
      async getInfo() {
        return {
          path: workspace.source,
          contextProjectionsPath: workspace.contextProjections,
        };
      },
    },
    fs: { ensureMaterialized },
    invocation: {
      current: () => ({
        caller: {
          callerId: caller.callerId ?? "panel:tree/panels~my-app/abc",
          callerKind: caller.callerKind ?? "panel",
          ...(caller.contextId ? { contextId: caller.contextId } : {}),
        },
        ...(caller.chainContextId ? { chainCaller: { contextId: caller.chainContextId } } : {}),
      }),
    },
    log: { info: vi.fn() },
  };
  return { ctx, ensureMaterialized };
}

describe("@workspace-extensions/test-runner", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    mockStartVitest.mockReset();
    mockStartVitest.mockResolvedValue({
      state: { getTestModules: () => [] },
      close: vi.fn(),
    });
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs tests from the caller context by default", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    const target = path.join(workspace.contextProjections, "ctx-1", "packages", "tool");
    fs.mkdirSync(target, { recursive: true });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    const result = await api.run("packages/tool");

    expect(result.summary).toContain("No test files found");
    expect(result.contextId).toBe("ctx-1");
    expect(ctx.fs.ensureMaterialized).toHaveBeenCalledWith("packages/tool");
    expect(mockStartVitest).toHaveBeenCalledWith(
      "test",
      [path.join(target, "**/*.test.{ts,tsx}")],
      expect.objectContaining({
        root: path.join(workspace.contextProjections, "ctx-1"),
      })
    );
  });

  it("materializes sparse context targets before checking disk", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    const target = path.join(workspace.contextProjections, "ctx-1", "extensions", "test-runner");
    const { ctx, ensureMaterialized } = makeCtx(workspace, { chainContextId: "ctx-1" });
    ensureMaterialized.mockImplementationOnce(async (scope) => {
      expect(scope).toBe("extensions/test-runner");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "index.test.ts"), "import { it } from 'vitest';\n");
    });
    const api = await activate(ctx);

    await api.run({ target: "extensions/test-runner", fileFilter: "index.test.ts" });

    expect(ensureMaterialized).toHaveBeenCalledWith("extensions/test-runner");
    expect(mockStartVitest).toHaveBeenCalledWith(
      "test",
      [path.join(target, "index.test.ts")],
      expect.objectContaining({
        root: path.join(workspace.contextProjections, "ctx-1"),
      })
    );
  });

  it("rejects path traversal before materialization", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    const { ctx, ensureMaterialized } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await expect(api.run("../secret")).rejects.toThrow("Target must not contain parent traversal");
    expect(ensureMaterialized).not.toHaveBeenCalled();
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("requires a context id", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    fs.mkdirSync(path.join(workspace.source, "packages", "tool"), { recursive: true });
    const { ctx } = makeCtx(workspace);
    ctx.invocation.current = () => ({
      caller: { callerId: "server:test", callerKind: "server" },
    });
    const api = await activate(ctx);

    await expect(api.run("packages/tool")).rejects.toThrow("requires a contextId");
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("injects panel setup for panel targets", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    fs.mkdirSync(path.join(workspace.contextProjections, "ctx-1", "panels", "my-app"), {
      recursive: true,
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await api.run("panels/my-app");

    expect(mockStartVitest).toHaveBeenCalledWith(
      "test",
      expect.any(Array),
      expect.objectContaining({
        setupFiles: [expect.stringContaining("panel-test-setup.mjs")],
      })
    );
  });

  it("ignores the retired caller-supplied approve flag", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    fs.mkdirSync(path.join(workspace.contextProjections, "ctx-1", "packages", "tool"), {
      recursive: true,
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await api.run({
      target: "packages/tool",
      approve: false,
    } as unknown as Parameters<typeof api.run>[0]);

    expect(mockStartVitest).toHaveBeenCalledTimes(1);
  });

  it("formats passing and failing test results", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    const target = path.join(workspace.contextProjections, "ctx-1", "packages", "tool");
    fs.mkdirSync(target, { recursive: true });
    mockStartVitest.mockResolvedValue({
      state: {
        getTestModules: () => [
          {
            moduleId: path.join(target, "index.test.ts"),
            state: () => "failed",
            errors: () => [],
            diagnostic: () => ({ duration: 10 }),
            children: {
              allTests: function* () {
                yield {
                  fullName: "passes",
                  result: () => ({ state: "passed", errors: undefined }),
                };
                yield {
                  fullName: "fails",
                  result: () => ({ state: "failed", errors: [{ message: "nope" }] }),
                };
              },
            },
          },
        ],
      },
      close: vi.fn(),
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    const result = await api.run("packages/tool");

    expect(result.summary).toBe("1 of 2 tests failed");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details[0]).toMatchObject({
      file: "packages/tool/index.test.ts",
      status: "fail",
      errors: ["fails: nope"],
    });
  });

  it("counts tests nested under Vitest suites", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contextProjections);
    const target = path.join(workspace.contextProjections, "ctx-1", "packages", "tool");
    fs.mkdirSync(target, { recursive: true });
    mockStartVitest.mockResolvedValue({
      state: {
        getTestModules: () => [
          {
            moduleId: path.join(target, "index.test.ts"),
            state: () => "passed",
            errors: () => [],
            diagnostic: () => ({ duration: 10 }),
            children: {
              allTests: function* () {
                yield {
                  fullName: "suite > first",
                  result: () => ({ state: "passed", errors: undefined }),
                };
                yield {
                  fullName: "suite > second",
                  result: () => ({ state: "passed", errors: undefined }),
                };
              },
            },
          },
        ],
      },
      close: vi.fn(),
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    const result = await api.run("packages/tool");

    expect(result).toMatchObject({
      summary: "2 tests passed",
      passed: 2,
      failed: 0,
      total: 2,
    });
  });
});

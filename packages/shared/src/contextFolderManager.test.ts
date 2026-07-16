import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { ContextFolderManager } from "./contextFolderManager.js";

describe("ContextFolderManager", () => {
  let root: string;
  let contextProjectionsRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cfm-"));
    contextProjectionsRoot = path.join(root, ".context-projections", "v5");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function manager(materialize?: (contextId: string) => Promise<{ dir: string }>) {
    return new ContextFolderManager({
      contextProjectionsRoot,
      materialize:
        materialize ??
        (async (contextId) => {
          const dir = path.join(contextProjectionsRoot, contextId);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "README.md"), "materialized");
          return { dir };
        }),
    });
  }

  it("materializes a missing context folder and returns its path", async () => {
    const cfm = manager();
    const dir = await cfm.ensureContextFolder("ctx-1");
    expect(dir).toBe(path.join(contextProjectionsRoot, "ctx-1"));
    await expect(fs.readFile(path.join(dir, "README.md"), "utf8")).resolves.toBe("materialized");
    expect(cfm.getContextFolderState("ctx-1")).toEqual({ status: "ready", path: dir });
  });

  it("does not re-materialize an existing folder", async () => {
    const materialize = vi.fn(async (contextId: string) => {
      const dir = path.join(contextProjectionsRoot, contextId);
      await fs.mkdir(dir, { recursive: true });
      return { dir };
    });
    const cfm = manager(materialize);
    await cfm.ensureContextFolder("ctx-1");
    await cfm.ensureContextFolder("ctx-1");
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent ensure calls", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((res) => (resolveGate = res));
    const materialize = vi.fn(async (contextId: string) => {
      await gate;
      const dir = path.join(contextProjectionsRoot, contextId);
      await fs.mkdir(dir, { recursive: true });
      return { dir };
    });
    const cfm = manager(materialize);
    const first = cfm.ensureContextFolder("ctx-1");
    const second = cfm.ensureContextFolder("ctx-1");
    // `materializing` is set only AFTER `fs.access` rejects (real I/O), so a single
    // macrotask tick is racy under full-suite load. Poll until materialization is
    // actually in-flight — the gate holds it in "materializing" until we resolve it.
    for (let i = 0; i < 200 && cfm.getContextFolderState("ctx-1").status !== "materializing"; i++) {
      await new Promise((res) => setTimeout(res, 1));
    }
    expect(cfm.getContextFolderState("ctx-1").status).toBe("materializing");
    resolveGate();
    expect(await first).toBe(await second);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it("validates context ids", async () => {
    const cfm = manager();
    await expect(cfm.ensureContextFolder("Bad/Id")).rejects.toThrow(/Invalid context ID/);
    await expect(cfm.ensureContextFolder("")).rejects.toThrow(/Invalid context ID/);
    expect(() => cfm.getContextFolderState("UPPER")).toThrow(/Invalid context ID/);
  });

  it("reports missing state and removes contexts", async () => {
    const cfm = manager();
    expect(cfm.getContextFolderState("ctx-9").status).toBe("missing");
    expect(cfm.getContextRoot("ctx-9")).toBeNull();
    const dir = await cfm.ensureContextFolder("ctx-9");
    expect(cfm.getContextRoot("ctx-9")).toBe(dir);
    await cfm.removeContext("ctx-9");
    expect(cfm.getContextFolderState("ctx-9").status).toBe("missing");
  });
});

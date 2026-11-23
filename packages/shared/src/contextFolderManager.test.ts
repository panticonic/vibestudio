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

  function manager() {
    return new ContextFolderManager({
      contextProjectionsRoot,
      contextScratchRoot: path.join(root, "scratch"),
      scratch: {
        ensure: async (contextId) => {
          await fs.mkdir(path.join(root, "scratch", contextId), { recursive: true });
        },
        remove: async (contextId) => {
          await fs.rm(path.join(root, "scratch", contextId), { recursive: true, force: true });
        },
      },
    });
  }

  it("resolves validated source addresses without creating a projection or scratch", async () => {
    const cfm = manager();
    expect(cfm.contextSourcePath("ctx-empty")).toBe(path.join(contextProjectionsRoot, "ctx-empty"));
    expect(cfm.getContextRoot("ctx-empty")).toBeNull();
    expect(() => cfm.contextSourcePath("../escape")).toThrow(/Invalid context ID/);
  });

  it("creates scratch without opening a source projection", async () => {
    const cfm = manager();
    const scratch = await cfm.ensureContextScratch("ctx-1");
    expect(scratch).toBe(path.join(root, "scratch", "ctx-1"));
    await expect(fs.stat(scratch)).resolves.toBeDefined();
    expect(cfm.getContextRoot("ctx-1")).toBeNull();
  });

  it("retains the original scratch failure without exposing it in the semantic message", async () => {
    const failure = new Error("native filesystem denied /private/host/path");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfm = new ContextFolderManager({
      contextProjectionsRoot,
      contextScratchRoot: path.join(root, "scratch"),
      scratch: {
        ensure: async () => {
          throw failure;
        },
        remove: async () => {},
      },
    });
    try {
      await expect(cfm.ensureContextScratch("ctx-1")).rejects.toMatchObject({
        message: "Confined context scratch creation failed",
        cause: failure,
      });
      expect(log).toHaveBeenCalledWith(
        "[ContextFolderManager] Confined context scratch creation failed:",
        failure
      );
    } finally {
      log.mockRestore();
    }
  });

  it("validates context ids", async () => {
    const cfm = manager();
    await expect(cfm.ensureContextScratch("Bad/Id")).rejects.toThrow(/Invalid context ID/);
    await expect(cfm.ensureContextScratch("")).rejects.toThrow(/Invalid context ID/);
    expect(() => cfm.getContextRoot("UPPER")).toThrow(/Invalid context ID/);
  });

  it("reports missing state and removes contexts", async () => {
    const cfm = manager();
    expect(cfm.getContextRoot("ctx-9")).toBeNull();
    const scratch = await cfm.ensureContextScratch("ctx-9");
    const source = cfm.contextSourcePath("ctx-9");
    await fs.mkdir(source, { recursive: true });
    expect(cfm.getContextRoot("ctx-9")).toBe(source);
    await cfm.removeContext("ctx-9");
    expect(cfm.getContextRoot("ctx-9")).toBeNull();
    await expect(fs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

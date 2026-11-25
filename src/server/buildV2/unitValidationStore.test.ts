import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UnitValidationStore } from "./unitValidationStore.js";

describe("exact unit validation persistence", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "unit-validation-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it("reuses compiler diagnostics across owners only for identical validation inputs", async () => {
    const compute = vi.fn(async () => ({ diagnostics: [], reusable: true }));
    const identity = { state: "exact", compiler: "v1", conditions: ["panel"] };
    await new UnitValidationStore(root).validate(identity, compute);
    await new UnitValidationStore(root).validate(identity, compute);
    expect(compute).toHaveBeenCalledOnce();
    await new UnitValidationStore(root).validate({ ...identity, state: "edited" }, compute);
    await new UnitValidationStore(root).validate({ ...identity, compiler: "v2" }, compute);
    await new UnitValidationStore(root).validate({ ...identity, conditions: ["worker"] }, compute);
    expect(compute).toHaveBeenCalledTimes(4);
  });
  it("does not memoize an infrastructure failure", async () => {
    const compute = vi.fn(async () => ({ diagnostics: [], reusable: false }));
    const store = new UnitValidationStore(root);
    await store.validate("same", compute);
    await store.validate("same", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
  it("propagates the original compiler rejection and leaves no completed record", async () => {
    const error = new Error("compiler exited");
    const compute = vi.fn().mockRejectedValue(error);
    const store = new UnitValidationStore(root);
    await expect(store.validate("same", compute)).rejects.toBe(error);
    await expect(store.validate("same", compute)).rejects.toBe(error);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

it("does not retain operational diagnostics even if a validation caller mistakenly marks them reusable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "operational-validation-"));
  try {
    const store = new UnitValidationStore(root),
      identity = { state: "same-source" };
    const diagnostic = {
      source: "infrastructure" as const,
      severity: "error" as const,
      file: "",
      line: 0,
      column: 0,
      message: "watch unavailable",
      operationalError: { code: "EMFILE" },
    };
    const compute = vi
      .fn()
      .mockResolvedValueOnce({ diagnostics: [diagnostic], reusable: true })
      .mockResolvedValue({ diagnostics: [], reusable: true });
    expect((await store.validate(identity, compute)).reusable).toBe(false);
    expect((await store.validate(identity, compute)).diagnostics).toEqual([]);
    await store.validate(identity, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("reuses real deterministic source errors while refusing a persisted infrastructure result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persisted-validation-"));
  try {
    const { sha256Canonical } = await import("@vibestudio/shared/authority/invocationSnapshot");
    const identity = { state: "unchanged" },
      key = sha256Canonical({ recipe: "unit-validation.v1", identity });
    const directory = path.join(root, key);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "validation.json"),
      JSON.stringify({
        key,
        diagnostics: [
          {
            source: "infrastructure",
            severity: "error",
            file: "",
            line: 0,
            column: 0,
            message: "owner retired",
          },
        ],
      })
    );
    const syntax = {
      source: "tsc" as const,
      severity: "error" as const,
      file: "src/a.ts",
      line: 1,
      column: 0,
      message: "Type mismatch",
      compilerCode: 2322,
    };
    const compute = vi.fn(async () => ({ diagnostics: [syntax], reusable: true }));
    expect((await new UnitValidationStore(root).validate(identity, compute)).diagnostics).toEqual([
      syntax,
    ]);
    expect((await new UnitValidationStore(root).validate(identity, compute)).diagnostics).toEqual([
      syntax,
    ]);
    expect(compute).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

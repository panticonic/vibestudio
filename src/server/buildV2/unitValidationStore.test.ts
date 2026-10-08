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

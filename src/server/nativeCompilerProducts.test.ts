import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  NativeCompilerProducts,
  compilerProductDriver,
  compilerProductExecArgv,
  readCompilerProductResult,
} from "./nativeCompilerProducts.js";
afterEach(() => {
  delete process.env["VIBESTUDIO_CACHE_COMPILER_PRODUCTS"];
});
const request = {
  bundle: "exact compiler",
  format: "cjs" as const,
  input: { project: { files: { "a.ts": "source" } }, options: { target: "node" } },
};
describe("isolated pure compiler ownership", () => {
  it("gives only compiler launches explicit bounded heap capacity with an opt-out", () => {
    expect(compilerProductExecArgv({})).toEqual(["--max-old-space-size=3072"]);
    expect(compilerProductExecArgv({ VIBESTUDIO_COMPILER_HEAP_MIB: "2048" })).toEqual([
      "--max-old-space-size=2048",
    ]);
    expect(compilerProductExecArgv({ VIBESTUDIO_COMPILER_HEAP_MIB: "0" })).toEqual([]);
    for (const value of ["-1", "1", "8193", "3.5", "3072 --inspect", ""])
      expect(() => compilerProductExecArgv({ VIBESTUDIO_COMPILER_HEAP_MIB: value })).toThrow(
        "COMPILER_HEAP_MIB"
      );
  });
  it("coalesces equal concurrent snapshots and returns separately owned data", async () => {
    const run = vi.fn(async (input) => {
      await Promise.resolve();
      return JSON.stringify({
        source: input.input.project.files["a.ts"],
        outputs: { a: "generated" },
      });
    });
    const cache = new NativeCompilerProducts(run);
    const [a, b] = (await Promise.all([
      cache.compile(request),
      cache.compile(structuredClone(request)),
    ])) as any[];
    expect(run).toHaveBeenCalledTimes(1);
    a.outputs.a = "poison";
    expect(b.outputs.a).toBe("generated");
    expect(((await cache.compile(request)) as any).outputs.a).toBe("generated");
  });
  it("abandoning one waiter does not cancel another caller's shared job", async () => {
    let finish!: (value: string) => void;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const cache = new NativeCompilerProducts(run);
    const controller = new AbortController();
    const first = cache.compile(request),
      second = cache.compile(request);
    const cancelled = Promise.race([
      first,
      new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        })
      ),
    ]);
    controller.abort(new Error("Eval cancelled"));
    await expect(cancelled).rejects.toThrow("Eval cancelled");
    await Promise.resolve();
    finish(JSON.stringify({ outputs: { value: "complete" } }));
    expect(await second).toEqual({ outputs: { value: "complete" } });
    expect(await first).toEqual({ outputs: { value: "complete" } });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("invalidates on compiler bytes and every explicit frontend input", async () => {
    const run = vi.fn(async () => JSON.stringify({ ok: true }));
    const cache = new NativeCompilerProducts(run);
    await cache.compile(request);
    await cache.compile({ ...request, bundle: "different compiler" });
    await cache.compile({
      ...request,
      input: { ...request.input, options: { target: "browser" } },
    });
    await cache.compile({
      ...request,
      input: { ...request.input, project: { files: { "a.ts": "changed" } } },
    });
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("bounds cached bytes and recovers its serial admission after compiler failure", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("compile failed"))
      .mockResolvedValue(JSON.stringify({ value: "x".repeat(80) }));
    const cache = new NativeCompilerProducts(run, 16);
    await expect(cache.compile(request)).rejects.toThrow("compile failed");
    await cache.compile(request);
    await cache.compile(request);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("supports explicit cache opt-out while retaining isolated compilation", async () => {
    process.env["VIBESTUDIO_CACHE_COMPILER_PRODUCTS"] = "0";
    const run = vi.fn(async () => JSON.stringify({ ok: true }));
    const cache = new NativeCompilerProducts(run);
    await Promise.all([cache.compile(request), cache.compile(request)]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("workspace retirement closes admission and rejects queued work before any native launch", async () => {
    let finish!: (value: string) => void;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const owner = new NativeCompilerProducts(run);
    const active = owner.compile(request);
    await Promise.resolve();
    const queued = owner.compile({ ...request, bundle: "different" });
    const rejected = expect(queued).rejects.toThrow("retired");
    const closing = owner.close();
    finish(JSON.stringify({ done: true }));
    await active;
    await rejected;
    await closing;
    await expect(owner.compile(request)).rejects.toThrow("retired");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("driver names exact explicit request and uses a private result file, not stdout", () => {
    const code = compilerProductDriver(
      { project: { files: { "quote.ts": "`literal`" } }, options: { target: "node" } },
      "/private/output.json",
      "async-cjs"
    );
    expect(code).toContain("compileVirtualProjectProduct(request.project,request.options)");
    expect(code).toContain('flag:"wx"');
    expect(code).not.toContain("console.log");
  });
});

it("accepts a valid compiler result above32MiB independently of its retention quota", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compiler-result-size-"));
  try {
    const result = path.join(root, "result.json");
    const content = JSON.stringify({ output: "x".repeat(33 * 1024 * 1024) });
    await writeFile(result, content, { flag: "wx" });
    const run = vi.fn(() => readCompilerProductResult(result));
    const owner = new NativeCompilerProducts(run, 1024);
    const first = (await owner.compile(request)) as { output: string };
    expect(first.output.length).toBe(33 * 1024 * 1024);
    const second = (await owner.compile(request)) as { output: string };
    expect(second.output).toBe(first.output);
    expect(run).toHaveBeenCalledTimes(2); // quota controls retention, never acceptance
    await owner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects non-UTF8 and symlink output and recovers after malformed JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compiler-result-rejection-"));
  try {
    const result = path.join(root, "result.json"),
      link = path.join(root, "link.json");
    await writeFile(result, Buffer.from([0xff]));
    await expect(readCompilerProductResult(result)).rejects.toThrow();
    await symlink(result, link);
    await expect(readCompilerProductResult(link)).rejects.toThrow();
    const run = vi.fn().mockResolvedValueOnce("{broken").mockResolvedValue('{"recovered":true}');
    const owner = new NativeCompilerProducts(run);
    await expect(owner.compile(request)).rejects.toThrow();
    expect(await owner.compile(request)).toEqual({ recovered: true });
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

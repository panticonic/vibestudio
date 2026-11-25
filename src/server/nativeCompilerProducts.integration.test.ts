import { it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
it.skipIf(!process.env["VIBESTUDIO_TEST_NATLANG_COMPILER_ENTRY"])(
  "actual native sandbox compiles a transportable product, shares pure work and cleans failures",
  async () => {
    if (!process.env["VIBESTUDIO_TEST_NATLANG_COMPILER_ENTRY"])
      throw new Error("Test requires the exact staged Natlang compiler entry");
    const root = await mkdtemp(path.join(tmpdir(), "native-compiler-product-"));
    let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
    try {
      await mkdir(path.join(root, "source"), { recursive: true });
      runtime = await startNativeWorkspaceRuntime({
        workspaceId: "pure-compiler",
        statePath: root,
        sourceRoot: path.join(root, "source"),
        scratchRoot: path.join(root, "scratch"),
        buildsRoot: path.join(root, "builds"),
        appRoot: process.env["VIBESTUDIO_TEST_INSTALLED_APP_ROOT"] ?? process.cwd(),
      });
      const run = vi.spyOn(runtime, "runJob");
      const bundled = await build({
        entryPoints: [process.env["VIBESTUDIO_TEST_NATLANG_COMPILER_ENTRY"]!],
        bundle: true,
        format: "cjs",
        platform: "node",
        write: false,
        nodePaths: [path.join(process.cwd(), "node_modules")],
        logLevel: "silent",
      });
      const request = {
        bundle: bundled.outputFiles[0]!.text,
        format: "cjs" as const,
        input: {
          project: {
            files: {
              "answer.nl": "---\nargs: { value: number }\nreturns: number\n---\nDouble value.",
            },
          },
          options: { target: "node", emit: false, adaptation: false },
        },
      };
      const [a, b] = (await Promise.all([
        runtime.compileProduct(request),
        runtime.compileProduct(request),
      ])) as any[];
      expect(a.schema).toBe("natlang.virtual-project-product/1");
      expect(a.build.ok).toBe(true);
      expect(Object.keys(a.build.declarations).length).toBeGreaterThan(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[1]).toEqual({ execArgv: ["--max-old-space-size=3072"] });
      // Observe inside the actual native workspace child, not the test parent's flags.
      const heap = (await runtime.compileProduct({
        bundle:
          'module.exports.compileVirtualProjectProduct=()=>({heap:require("node:v8").getHeapStatistics().heap_size_limit,argv:process.execArgv});',
        format: "cjs",
        input: {},
      })) as { heap: number; argv: string[] };
      expect(heap.argv).toEqual(["--max-old-space-size=3072"]);
      expect(heap.heap).toBeGreaterThanOrEqual(3072 * 1024 * 1024);
      // V8 reports total heap including young generations; the explicit old-space
      // ceiling is the launch argument, not an assumed total-heap overhead.
      const previousHeap = process.env["VIBESTUDIO_COMPILER_HEAP_MIB"];
      try {
        process.env["VIBESTUDIO_COMPILER_HEAP_MIB"] = "0";
        const automatic = (await runtime.compileProduct({
          bundle:
            'module.exports.compileVirtualProjectProduct=()=>({heap:require("node:v8").getHeapStatistics().heap_size_limit,argv:process.execArgv});',
          format: "cjs",
          input: { uncachedOptOutWitness: true },
        })) as { heap: number; argv: string[] };
        expect(automatic.argv).toEqual([]);
        expect(automatic.heap).toBeGreaterThan(0);
        console.info(
          JSON.stringify({ schema: "native.compiler-heap-witness/1", explicit: heap, automatic })
        );
      } finally {
        if (previousHeap === undefined) delete process.env["VIBESTUDIO_COMPILER_HEAP_MIB"];
        else process.env["VIBESTUDIO_COMPILER_HEAP_MIB"] = previousHeap;
      }
      // Exercise the real native output file and owner transport above the old
      // 32MiB acceptance ceiling, independently of cache retention policy.
      const large = (await runtime.compileProduct({
        bundle:
          'module.exports.compileVirtualProjectProduct=()=>({value:"x".repeat(33*1024*1024)});',
        format: "cjs",
        input: {},
      })) as { value: string };
      expect(large.value.length).toBe(33 * 1024 * 1024);
      expect(large.value[0]).toBe("x");
      a.build.diagnostics.push("poison");
      expect(b.build.diagnostics).toEqual([]);
      await expect(
        runtime.compileProduct({
          ...request,
          bundle: 'throw new Error("native compiler failure");',
        })
      ).rejects.toThrow();
      const recovered = (await runtime.compileProduct({
        ...request,
        input: { ...request.input, options: { ...request.input.options, programId: "new" } },
      })) as any;
      expect(recovered.build.ok).toBe(true);
      expect(await readdir(path.join(root, "scratch/native-compiler-products"))).toEqual([]);
    } finally {
      if (runtime) {
        const stopped = await runtime.stop();
        expect(stopped.launcherExited).toBe(true);
        await runtime.retireStorage();
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000
);

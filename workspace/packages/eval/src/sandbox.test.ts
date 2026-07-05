import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSandbox } from "./sandbox";

describe("executeSandbox", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;
  let originalLoadImport: unknown;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    originalPreload = (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    originalLoadImport = (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"];

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = async (ids: string[]) => (
      ids.map((id) => {
        if (id in moduleMap) return moduleMap[id];
        throw new Error(`Module not found: ${id}`);
      })
    );
  });

  afterEach(() => {
    if (originalModuleMap === undefined) delete (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    else (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined) delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    else (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = originalRequire;
    if (originalPreload === undefined) delete (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = originalPreload;
    if (originalLoadImport === undefined) delete (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"];
    else (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"] = originalLoadImport;
  });

  it("settles a pending async eval when its signal is aborted", async () => {
    const controller = new AbortController();
    const pending = executeSandbox("return await new Promise(() => {});", {
      syntax: "typescript",
      signal: controller.signal,
    });

    controller.abort("User interrupted execution");

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: "User interrupted execution",
    });
  });

  it("fails fast when the signal is already aborted before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeSandbox("return 21 + 21;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("completes normally when an unaborted signal is provided", async () => {
    const controller = new AbortController();
    const result = await executeSandbox("return 1 + 2;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
  });

  it("does not suggest npm imports for unavailable Node built-ins", async () => {
    const result = await executeSandbox(
      'import { spawn } from "node:child_process"; return spawn;',
      {
        syntax: "typescript",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Node built-in module "node:child_process" is not available');
    expect(result.error).toContain("@workspace/runtime");
    expect(result.error).not.toContain("npm:latest");
  });

  it("exposes a lazy import loader to runtime helpers during eval", async () => {
    const result = await executeSandbox(
      "const loaded = await globalThis.__vibestudioLoadImport__('lazy-package', 'latest'); return loaded.answer;",
      {
        syntax: "typescript",
        loadImport: async (specifier, ref, externals) => {
          expect(specifier).toBe("lazy-package");
          expect(ref).toBeUndefined();
          expect(externals).toEqual([]);
          return "module.exports = { answer: 42 };";
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    expect((globalThis as Record<string, unknown>)["__vibestudioLoadImport__"]).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = async (
      ids: string[]
    ) =>
      ids.map((id) => {
        if (id in moduleMap) return moduleMap[id];
        throw new Error(`Module not found: ${id}`);
      });
  });

  afterEach(() => {
    if (originalModuleMap === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    else (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    else (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = originalRequire;
    if (originalPreload === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = originalPreload;
    if (originalLoadImport === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"];
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

  it("awaits a trailing async IIFE as the eval result", async () => {
    const result = await executeSandbox(
      "(async () => { await Promise.resolve(); return 42; })();",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 42 });
  });

  it("returns a trailing object literal like a notebook REPL", async () => {
    const result = await executeSandbox(
      "const path = 'probe.txt';\nconst actorId = 'agent:1';\n{ path, actorId, turnId: 'turn:1' }",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: { path: "probe.txt", actorId: "agent:1", turnId: "turn:1" },
    });
  });

  it("repairs transport-escaped whitespace outside literals", async () => {
    const result = await executeSandbox(
      String.raw`return { first: 1,\n second: 2, text: "keep,\\n literal" };`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: { first: 1, second: 2, text: "keep,\\n literal" },
    });
  });

  it("repairs a missing call parenthesis before a line-ending semicolon", async () => {
    const result = await executeSandbox(
      "const list = [{repoPath: 'demo'}];\nconsole.log(JSON.stringify({count:list.length, repos:list.map(s=>s.repoPath)});\nreturn list.length;",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 1 });
  });

  it("does not treat parentheses inside a regular-expression literal as unmatched calls", async () => {
    const result = await executeSandbox('const value = /\\(/.test("("); return value;', {
      syntax: "typescript",
    });

    expect(result).toMatchObject({ success: true, returnValue: true });
  });

  it("repairs a leaked tool-call JSON suffix after otherwise complete code", async () => {
    const result = await executeSandbox('const value = 41;\nreturn value + 1;\n"}', {
      syntax: "typescript",
    });

    expect(result).toMatchObject({ success: true, returnValue: 42 });
  });

  it("lifts direct node:fs sync calls to awaited portable operations", async () => {
    const files = new Map<string, string | Uint8Array>();
    const nodeFs = {
      async writeFile(path: string, data: string | Uint8Array) {
        files.set(path, data);
      },
      async readFile(path: string) {
        return files.get(path);
      },
      async unlink(path: string) {
        files.delete(path);
      },
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      "import fs from 'node:fs';\nfs.writeFileSync('/tmp/a', 'hello');\nconst text = fs.readFileSync('/tmp/a');\nfs.unlinkSync('/tmp/a');\nreturn { text, gone: !files.has('/tmp/a') };",
      {
        syntax: "typescript",
        bindings: { files },
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toEqual({ text: "hello", gone: true });
  });

  it("never injects await into a nested synchronous helper while lifting outer fs calls", async () => {
    const files = new Map<string, string>();
    const links = new Map<string, string>();
    const nodeFs = {
      async writeFile(path: string, data: string) {
        files.set(path, data);
      },
      async symlink(target: string, path: string) {
        links.set(path, target);
      },
      async readFile(path: string) {
        return files.get(links.get(path) ?? path);
      },
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      `import fs from "node:fs";
function cleanup(path: string) {
  try { if (fs.existsSync(path)) fs.unlinkSync(path); } catch {}
}
cleanup("/tmp/link");
fs.writeFileSync("/tmp/target", "ok");
fs.symlinkSync("/tmp/target", "/tmp/link", "file");
return fs.readFileSync("/tmp/link");`,
      {
        syntax: "typescript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("ok");
  });

  it("never injects await into an expression-bodied synchronous arrow", async () => {
    const nodeFs = {
      async writeFile() {},
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      `import fs from "node:fs";
const write = () => fs.writeFileSync("/tmp/value", "ok");
return typeof write;`,
      {
        syntax: "typescript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("function");
  });

  it("accepts JavaScript syntax and lifts bare require('fs') calls", async () => {
    const files = new Map<string, string>();
    const fsModule = {
      async writeFile(path: string, data: string) {
        files.set(path, data);
      },
      async readFile(path: string) {
        return files.get(path);
      },
    };
    const moduleMap = { fs: fsModule };
    const result = await executeSandbox(
      `const fs = require("fs");
fs.writeFileSync("/tmp/a", "ok");
return fs.readFileSync("/tmp/a");`,
      {
        syntax: "javascript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("ok");
  });

  it("does not alter semicolons in a valid for header", async () => {
    const result = await executeSandbox(
      "let total = 0; for (let i = 0; i < 3; i++) total += i; return total;",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 3 });
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

  it("auto-loads an unscoped manifest-declared workspace unit", async () => {
    const resolveWorkspaceImport = vi.fn(async (specifier: string) => specifier === "local-worker");
    const loadImport = Object.assign(
      vi.fn(async (specifier: string, ref: string | undefined) => {
        expect(specifier).toBe("local-worker");
        expect(ref).toBeUndefined();
        return "module.exports = { answer: 42 };";
      }),
      { resolveWorkspaceImport }
    );

    const result = await executeSandbox('import { answer } from "local-worker"; return answer;', {
      syntax: "typescript",
      loadImport,
    });

    expect(result).toMatchObject({ success: true, returnValue: 42 });
    expect(resolveWorkspaceImport).toHaveBeenCalledWith("local-worker");
    expect(loadImport).toHaveBeenCalledOnce();
  });

  it("keeps unknown npm packages on the explicit npm import path", async () => {
    const resolveWorkspaceImport = vi.fn(async () => false);
    const loadImport = Object.assign(vi.fn(), { resolveWorkspaceImport });

    const result = await executeSandbox('import pad from "left-pad"; return pad;', {
      syntax: "typescript",
      loadImport,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Module "left-pad" not available');
    expect(result.error).toContain('"left-pad":"npm:latest"');
    expect(loadImport).not.toHaveBeenCalled();
  });

  it("maps a flat workspace alias to an already preloaded canonical module", async () => {
    const canonical = { answer: 42 };
    const moduleMap = { "@workspace/runtime": canonical };
    const loadImport = vi.fn();

    const result = await executeSandbox(
      'import { answer } from "@workspace-runtime"; return answer;',
      {
        syntax: "typescript",
        imports: { "@workspace-runtime": "workspace-runtime" },
        moduleMap,
        loadImport,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result).toMatchObject({ success: true, returnValue: 42 });
    expect(moduleMap["@workspace-runtime" as keyof typeof moduleMap]).toBe(canonical);
    expect(loadImport).not.toHaveBeenCalled();
  });
});

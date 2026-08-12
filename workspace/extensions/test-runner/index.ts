import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface TestRunRequest {
  target: string;
  contextId?: string;
  fileFilter?: string;
  testName?: string;
}

export interface TestRunResult {
  summary: string;
  passed: number;
  failed: number;
  total: number;
  contextId: string;
  target: string;
  pattern: string;
  details: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextProjectionsPath: string }>;
  };
  fs: {
    ensureMaterialized(scope: string | string[] | "all"): Promise<void>;
  };
  invocation: {
    current(): {
      caller: { callerId: string; callerKind?: string; contextId?: string };
      chainCaller?: { contextId?: string };
    } | null;
  };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
  };
}

const WORKSPACE_ROOTS = new Set([
  "about",
  "apps",
  "extensions",
  "packages",
  "panels",
  "projects",
  "skills",
  "templates",
  "workers",
]);

const PANEL_SETUP_SOURCE = `
export {};
globalThis.__vibestudioModuleMap__ = globalThis.__vibestudioModuleMap__ ?? {};
globalThis.__vibestudioRequire__ = (id) => globalThis.__vibestudioModuleMap__[id];
globalThis.__vibestudioRequireAsync__ = async (id) => globalThis.__vibestudioModuleMap__[id];
globalThis.__vibestudioEntityId = "test-panel";
globalThis.__vibestudioContextId = "ctx-test";
`;

function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(`Invalid context ID: ${contextId}`);
  }
}

function assertWorkspaceTarget(target: string): void {
  if (!target || path.isAbsolute(target)) {
    throw new Error(`Target must be a workspace-relative path: ${target}`);
  }
  const normalized = target.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Target must not contain parent traversal: ${target}`);
  }
  const [root] = normalized.split("/");
  if (!root || !WORKSPACE_ROOTS.has(root)) {
    throw new Error(`Target must start with a workspace unit root: ${target}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes test root: ${relativePath}`);
  }
  return resolved;
}

function currentInvocationContextId(ctx: ExtensionContextLike): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

function normalizeRunRequest(
  requestOrTarget: TestRunRequest | string,
  options: Omit<TestRunRequest, "target"> = {}
): TestRunRequest {
  if (typeof requestOrTarget === "string") return { ...options, target: requestOrTarget };
  return requestOrTarget;
}

function testPatternFor(targetPath: string, fileFilter?: string): string {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return targetPath;
  if (!stat.isDirectory()) throw new Error(`Target must be a file or directory: ${targetPath}`);
  if (fileFilter) return resolveWithin(targetPath, fileFilter);
  // Select the unit and let Vitest own test-file discovery. Repeating Vitest's
  // include rules here drifted from its actual semantics: in particular, the
  // recursive glob missed a unit-root index.test.ts and excluded valid spec,
  // JavaScript, MTS, and CTS tests.
  return targetPath;
}

function ensurePanelSetupFile(): string {
  const setupDir = path.join(os.tmpdir(), "vibestudio-workspace-test-runner");
  fs.mkdirSync(setupDir, { recursive: true });
  const setupFile = path.join(setupDir, "panel-test-setup.mjs");
  fs.writeFileSync(setupFile, PANEL_SETUP_SOURCE);
  return setupFile;
}

function formatErrors(name: string | undefined, errors: readonly unknown[] | undefined): string[] {
  return (errors ?? []).map((error) => {
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
    return name ? `${name}: ${message}` : message;
  });
}

function modulePath(moduleId: string): string {
  return moduleId.startsWith("file:") ? fileURLToPath(moduleId) : moduleId;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry.
// test-runner is agent/host infrastructure and imports Node/Vitest modules;
// registering it would drag that type graph into every panel type-check.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("test-runner activating");
  return {
    async run(
      requestOrTarget: TestRunRequest | string,
      options?: Omit<TestRunRequest, "target">
    ): Promise<TestRunResult> {
      const request = normalizeRunRequest(requestOrTarget, options);
      assertWorkspaceTarget(request.target);

      const info = await ctx.workspace.getInfo();
      const contextId = request.contextId ?? currentInvocationContextId(ctx);
      if (!contextId) {
        throw new Error("test-runner.run requires a contextId");
      }
      validateContextId(contextId);
      const root = path.join(info.contextProjectionsPath, contextId);
      await ctx.fs.ensureMaterialized(request.target);
      const targetPath = resolveWithin(root, request.target);
      if (!fs.existsSync(targetPath)) {
        throw new Error(`Target does not exist: ${request.target}`);
      }

      const pattern = testPatternFor(targetPath, request.fileFilter);
      const setupFiles = request.target.startsWith("panels/") ? [ensurePanelSetupFile()] : [];
      const { startVitest } = await import("vitest/node");
      const vitest = await startVitest("test", [pattern], {
        // The projection is the caller's exact semantic context. Rooting
        // Vitest at the source checkout makes an absolute projected file look
        // external, so Vitest silently discovers zero files and can resolve
        // config from the wrong workspace state.
        root,
        exclude: ["**/node_modules/**", "dist"],
        setupFiles,
        testNamePattern: request.testName,
        reporters: ["default"],
        silent: true,
      });

      if (!vitest) {
        return {
          summary: "Vitest failed to start",
          passed: 0,
          failed: 0,
          total: 0,
          contextId,
          target: request.target,
          pattern,
          details: [],
        };
      }

      try {
        const modules = vitest.state.getTestModules();
        let passed = 0;
        let failed = 0;
        const details: TestRunResult["details"] = [];

        for (const module of modules) {
          const moduleErrors = formatErrors(undefined, module.errors());
          let moduleFailedTests = 0;
          for (const test of module.children.allTests()) {
            const result = test.result();
            if (result.state === "passed") {
              passed++;
            } else if (result.state === "failed") {
              failed++;
              moduleFailedTests++;
              moduleErrors.push(...formatErrors(test.fullName, result.errors));
            }
          }
          const moduleState = module.state();
          if (moduleState === "failed" && moduleFailedTests === 0) {
            failed++;
          }
          const fileStatus: "pass" | "fail" | "skip" =
            moduleState === "failed" ? "fail" : moduleState === "passed" ? "pass" : "skip";
          details.push({
            file: path.relative(root, modulePath(module.moduleId)),
            status: fileStatus,
            duration: module.diagnostic().duration,
            ...(moduleErrors.length > 0 ? { errors: moduleErrors } : {}),
          });
        }

        const total = passed + failed;
        const summary =
          modules.length === 0
            ? `No test files found matching: ${request.target}${request.fileFilter ? `/${request.fileFilter}` : ""}`
            : failed > 0
              ? `${failed} of ${total} test${total !== 1 ? "s" : ""} failed`
              : `${total} test${total !== 1 ? "s" : ""} passed`;

        return {
          summary,
          passed,
          failed,
          total,
          contextId,
          target: request.target,
          pattern,
          details,
        };
      } finally {
        await vitest.close();
      }
    },
  };
}

/**
 * Natlang provider integration of the EvalDO: lazy load, lowering, the
 * `runCell` wrapper, cancellation, ambient injection, and teardown. The
 * provider is a fake module honoring the host contract; the engine and runtime
 * are stubbed so `runLocked` itself runs.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { NATLANG_PROVIDER_HOST_CONTRACT_VERSION } from "@vibestudio/service-schemas/evalNatlang";
import type {
  EvalNatlang,
  NatlangLoweredCell,
  NatlangProviderHost,
} from "@vibestudio/service-schemas/evalNatlang";
import { evalRunResultSchema } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";
import { cellMayReferenceNatlang } from "./evalNatlangProvider.js";

const NATLANG_SOURCE = "@workspace/natlang";

type Priv = Record<string, unknown>;
const setPriv = (instance: object, key: string, value: unknown): void => {
  (instance as Priv)[key] = value;
};

interface FakeProvider {
  module: Record<string, unknown>;
  created: Array<{ host: NatlangProviderHost; natlang: EvalNatlang }>;
  lowered: Array<{ source: string; options: Record<string, unknown> }>;
  runCells: Array<{ runId: string; signal: AbortSignal }>;
  closed: number;
  lower: (source: string) => NatlangLoweredCell;
}

function fakeProvider(overrides: Partial<{ version: unknown }> = {}): FakeProvider {
  const state: FakeProvider = {
    module: {},
    created: [],
    lowered: [],
    runCells: [],
    closed: 0,
    lower: (source) => ({ usesNl: true, code: `/*lowered*/${source}`, diagnostics: [] }),
  };
  state.module = {
    NATLANG_PROVIDER_HOST_CONTRACT_VERSION:
      "version" in overrides ? overrides.version : NATLANG_PROVIDER_HOST_CONTRACT_VERSION,
    createEvalNatlang: (host: NatlangProviderHost): EvalNatlang => {
      const natlang: EvalNatlang = {
        ambient: {
          nl: { __inline: "inline" },
          natlang: { help: () => "natlang help text" },
          __natlang: { readNeuralese: "plumbing" },
        },
        lowerCell: (source, options) => {
          state.lowered.push({ source, options: options as unknown as Record<string, unknown> });
          return state.lower(source);
        },
        runCell: async (execute, options) => {
          state.runCells.push(options);
          const value = await execute();
          return {
            value,
            calls: [
              {
                callId: "c1",
                name: "triage",
                outcome: "ok",
                turns: 1,
                promptTokens: 2,
                completionTokens: 3,
                durationMs: 4,
              },
            ],
          };
        },
        close: () => {
          state.closed += 1;
        },
      };
      state.created.push({ host, natlang });
      return natlang;
    },
  };
  return state;
}

interface Harness {
  instance: EvalDO;
  provider: FakeProvider;
  loadLibraryModule: ReturnType<typeof vi.fn>;
  executed: Array<{ code: string; options: Record<string, unknown> }>;
  scope: Record<string, unknown>;
  reseedScopeManager: () => void;
  run: (code: string, signal?: AbortSignal, runId?: string) => Promise<Record<string, unknown>>;
}

async function harness(options: { declared?: boolean; version?: unknown } = {}): Promise<Harness> {
  const { instance } = await createTestDO(EvalDO);
  const env = (instance as unknown as { env: Record<string, unknown> }).env;
  env["EVAL_RUNTIME_SOURCE"] = "packages/runtime";
  if (options.declared !== false) env["EVAL_NATLANG_SOURCE"] = NATLANG_SOURCE;
  const provider = fakeProvider("version" in options ? { version: options.version } : {});
  const executed: Harness["executed"] = [];
  const scope: Record<string, unknown> = {};
  const loadLibraryModule = vi.fn(async (specifier: string) => {
    if (specifier !== NATLANG_SOURCE) throw new Error(`unexpected library ${specifier}`);
    (instance as unknown as { isolateModuleMap: Priv }).isolateModuleMap[specifier] =
      provider.module;
    return provider.module;
  });
  setPriv(instance, "loadLibraryModule", loadLibraryModule);
  setPriv(instance, "engine", {
    EVAL_ENGINE_HOST_CONTRACT_VERSION: 1,
    executeSandbox: vi.fn(async (code: string, opts: Record<string, unknown>) => {
      executed.push({ code, options: opts });
      return { success: true, consoleOutput: "", returnValue: "done" };
    }),
  });
  setPriv(instance, "runtimeSupport", {});
  setPriv(instance, "portableHelpers", {});
  setPriv(instance, "runtimeUnitIdentity", {
    source: "packages/runtime",
    unit: {
      name: "@workspace/runtime",
      kind: "package",
      relativePath: "packages/runtime",
      isRoot: true,
    },
  });
  const seedScopeManager = (): void =>
    setPriv(instance, "scopeManager", {
      current: scope,
      enterEval: () => undefined,
      exitEval: async () => undefined,
      apiFrom: () => ({}),
    });
  seedScopeManager();
  // help() overview lists services over RPC; none exist in this harness.
  const createExecutionContext = (instance as unknown as Priv)["createExecutionContext"] as (
    ...args: unknown[]
  ) => object;
  setPriv(instance, "createExecutionContext", (...args: unknown[]) => ({
    ...createExecutionContext.apply(instance, args),
    docs: { listServices: async () => [] },
  }));

  setPriv(instance, "createScopePersistence", () => ({}));
  setPriv(instance, "createRunHostedRuntime", () => ({ fs: {}, rpc: { marker: "rt" } }));
  setPriv(instance, "makeLoadImport", () => ({}));
  return {
    instance,
    provider,
    loadLibraryModule,
    executed,
    scope,
    reseedScopeManager: seedScopeManager,
    run: (code, signal, runId = "run-1") =>
      (
        instance as unknown as {
          runLocked(
            args: unknown,
            signal?: AbortSignal,
            runId?: string
          ): Promise<Record<string, unknown>>;
        }
      ).runLocked({ code, gatewayToken: "token", contextId: "ctx" }, signal, runId),
  };
}

const boundNames = (h: Harness, index = 0): string[] =>
  Object.keys((h.executed[index]!.options["bindings"] ?? {}) as object);

describe("EvalDO natlang provider", () => {
  it("prechecks lexically for nl, natlang, iterateOn, and Neuralese", () => {
    for (const code of [
      "nl`x`",
      'import n from "@workspace/natlang"',
      "iterateOn(f)",
      "Neuralese<string>",
      'help("nl")',
    ]) {
      expect(cellMayReferenceNatlang(code), code).toBe(true);
    }
    for (const code of ["const final = 1", "snl + nlx", "await fs.readFile('a')"]) {
      expect(cellMayReferenceNatlang(code), code).toBe(false);
    }
  });

  it("never loads the provider for a cell that cannot reference it", async () => {
    const h = await harness();
    const result = await h.run("return 1 + 1");
    expect(h.loadLibraryModule).not.toHaveBeenCalled();
    expect(h.provider.created).toHaveLength(0);
    expect(boundNames(h)).not.toContain("nl");
    expect(boundNames(h)).not.toContain("natlang");
    expect(h.executed[0]!.code).toBe("return 1 + 1");
    expect(result["natlang"]).toBeUndefined();
  });

  it("does not load when no provider is declared", async () => {
    const h = await harness({ declared: false });
    await h.run("await nl`x`()");
    expect(h.loadLibraryModule).not.toHaveBeenCalled();
    expect(h.executed[0]!.code).toBe("await nl`x`()");
  });

  it("loads lazily once, injects every ambient key, lowers, and wraps execution in runCell", async () => {
    const h = await harness();
    h.scope["ticket"] = { id: 1 };
    const result = await h.run("await nl`Decide ${ticket}`()", undefined, "run-7");
    await h.run("await nl`again`()", undefined, "run-8");

    expect(h.loadLibraryModule).toHaveBeenCalledTimes(2);
    expect(h.provider.created).toHaveLength(1);
    const { host } = h.provider.created[0]!;
    expect(host.bindings["rpc"]).toEqual({ marker: "rt" });
    expect(host.owner).toMatchObject({ kind: "user" });
    expect(host.owner.objectKey).toEqual(expect.any(String));

    expect(boundNames(h)).toEqual(expect.arrayContaining(["nl", "natlang", "__natlang"]));
    expect(h.executed[0]!.code).toBe("/*lowered*/await nl`Decide ${ticket}`()");
    expect(h.provider.lowered[0]!.options).toMatchObject({
      fileName: "cell.tsx",
      jsx: true,
      scopeValues: h.scope,
    });
    expect(h.provider.lowered[0]!.options["ambientNames"]).toEqual(
      expect.arrayContaining(["nl", "natlang", "__natlang", "fs", "rpc"])
    );
    expect(h.provider.runCells.map((c) => c.runId)).toEqual(["run-7", "run-8"]);
    expect(result["success"]).toBe(true);
    expect(result["natlang"]).toMatchObject({
      calls: [{ callId: "c1", name: "triage", outcome: "ok" }],
    });
  });

  it("registers the provider under its source specifier for workspace imports", async () => {
    const h = await harness();
    await h.run("await nl`x`()");
    const moduleMap = h.executed[0]!.options["moduleMap"] as Record<string, unknown>;
    expect(moduleMap[NATLANG_SOURCE]).toBe(h.provider.module);
  });

  it("keeps a failed natlang call's typed record and its call summaries in the run result", async () => {
    const h = await harness();
    const failure = {
      protocol: "natlang-call-failure/1",
      code: "natlang_call_failed",
      callId: "run-1-1/1",
      name: "triage",
      reason: "blocked",
      outcome: "quiesced",
      detail: "blocked: no ticket text was given",
      trace: 'await natlang.trace("run-1-1/1")',
      next: "pass the missing evidence as an argument",
    };
    setPriv(h.instance, "engine", {
      EVAL_ENGINE_HOST_CONTRACT_VERSION: 1,
      executeSandbox: vi.fn(async () => ({
        success: false,
        consoleOutput: "",
        error: {
          message: "natlang triage: quiesced: blocked: no ticket text was given (record run-1-1/1)",
          name: "NatlangCallError",
          errorKind: "application",
          errorData: failure,
        },
        failureKind: "user-code",
        failureCode: "natlang_call_failed",
      })),
    });
    const summaries = [
      {
        callId: "run-1-1/1",
        name: "triage",
        outcome: "quiesced",
        reason: "blocked",
        turns: 1,
        promptTokens: 2,
        completionTokens: 3,
        durationMs: 4,
        decision: {
          mode: "scored" as const,
          value: '"urgent"',
          p: 0.55,
          runnerUp: '"normal"',
          pRunnerUp: 0.45,
        },
      },
    ];
    const create = h.provider.module["createEvalNatlang"] as (
      host: NatlangProviderHost
    ) => EvalNatlang;
    h.provider.module["createEvalNatlang"] = (host: NatlangProviderHost) => ({
      ...create(host),
      runCell: async (execute: () => Promise<unknown>) => ({
        value: await execute(),
        calls: summaries,
      }),
    });
    const result = await h.run("await nl`x`()");
    expect(result).toMatchObject({
      success: false,
      failureKind: "user-code",
      failureCode: "natlang_call_failed",
      error: { errorData: failure },
      natlang: { calls: summaries },
    });
    expect(() => evalRunResultSchema.parse(result)).not.toThrow();
  });

  it("turns lowering error diagnostics into a user-code failure and does not execute", async () => {
    const h = await harness();
    h.provider.lower = (source) => ({
      usesNl: true,
      code: source,
      diagnostics: [
        { code: "NL1001", message: "needs nl<T>", line: 3, column: 9, severity: "error" },
        { code: "NL2002", message: "slow", line: 1, column: 1, severity: "warning" },
      ],
    });
    const result = await h.run("await nl`x`()");
    expect(h.executed).toHaveLength(0);
    expect(h.provider.runCells).toHaveLength(0);
    expect(result["success"]).toBe(false);
    expect(result["failureKind"]).toBe("user-code");
    expect(result["failureCode"]).toBe("natlang_lowering_failed");
    expect(JSON.stringify(result["error"])).toContain("cell.tsx:3:9 NL1001: needs nl<T>");
    expect(JSON.stringify(result["error"])).not.toContain("NL2002");
  });

  it("reports lowering warnings on the cell console and still executes", async () => {
    const h = await harness();
    h.provider.lower = (source) => ({
      usesNl: true,
      code: source,
      diagnostics: [{ code: "NL2002", message: "slow", line: 1, column: 5, severity: "warning" }],
    });
    const result = await h.run("await nl`x`()");
    expect(h.executed).toHaveLength(1);
    expect(result["console"]).toContain("[natlang] warning cell.tsx:1:5 NL2002: slow");
  });

  it("hands the run's abort signal to runCell", async () => {
    const h = await harness();
    const controller = new AbortController();
    await h.run("await nl`x`()", controller.signal);
    const { signal } = h.provider.runCells[0]!;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("cancels natlang through a forced reset and closes the owner's instance", async () => {
    const h = await harness();
    await h.run("await nl`x`()");
    expect(h.provider.closed).toBe(0);
    (h.instance as unknown as { resetLocked(): unknown }).resetLocked();
    expect(h.provider.closed).toBe(1);
    // The next natlang cell creates a fresh instance for the new notebook.
    h.reseedScopeManager();
    await h.run("await nl`y`()");
    expect(h.provider.created).toHaveLength(2);
  });

  it("closes the instance when the kernel heap is released", async () => {
    const h = await harness();
    await h.run("await nl`x`()");
    (h.instance as unknown as { releaseKernelReferences(): void }).releaseKernelReferences();
    expect(h.provider.closed).toBe(1);
  });

  it("rejects a provider built for another host contract before running the cell", async () => {
    const other = NATLANG_PROVIDER_HOST_CONTRACT_VERSION + 1;
    const h = await harness({ version: other });
    await expect(h.run("await nl`x`()")).rejects.toThrow(
      `uses host contract ${other}; this runtime requires ${NATLANG_PROVIDER_HOST_CONTRACT_VERSION}`
    );
    expect(h.executed).toHaveLength(0);

    const missing = await harness({ version: undefined });
    await expect(missing.run("await nl`x`()")).rejects.toThrow(
      `uses host contract undefined; this runtime requires ${NATLANG_PROVIDER_HOST_CONTRACT_VERSION}`
    );
  });

  it("describes nl and natlang from the provider's help", async () => {
    const h = await harness();
    await h.run('await help("nl")');
    const bindings = h.executed[0]!.options["bindings"] as Record<
      string,
      (name?: string) => Promise<unknown>
    >;
    await expect(bindings["help"]!("natlang")).resolves.toEqual({
      name: "natlang",
      surface: "natlang",
      help: "natlang help text",
    });
    const overview = (await bindings["help"]!()) as { ambient: string[] };
    expect(overview.ambient).toEqual(expect.arrayContaining(["nl", "natlang"]));
    expect(overview.ambient).not.toContain("__natlang");
  });

  it("omits nl and natlang from the help overview when no provider is declared", async () => {
    const h = await harness({ declared: false });
    await h.run("return 1");
    const bindings = h.executed[0]!.options["bindings"] as Record<
      string,
      (name?: string) => Promise<unknown>
    >;
    const overview = (await bindings["help"]!()) as { ambient: string[] };
    expect(overview.ambient).not.toContain("nl");
    expect(overview.ambient).not.toContain("natlang");
    expect(overview.ambient).toContain("scope");
  });
});

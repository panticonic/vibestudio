import { serializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import {
  EVAL_NATLANG_RESULT_MAX_CALLS,
  type EvalNatlangCallSummary,
  type EvalNatlangResult,
} from "@vibestudio/service-schemas/eval";
import {
  NATLANG_AMBIENT_NAMES,
  NATLANG_PROVIDER_HOST_CONTRACT_VERSION,
  type EvalNatlang,
  type NatlangLowerOptions,
  type NatlangLoweredCell,
  type NatlangProviderHost,
  type NatlangProviderModule,
} from "@vibestudio/service-schemas/evalNatlang";

/**
 * Host side of the manifest-declared natlang provider (`providers.natlang`,
 * injected as `EVAL_NATLANG_SOURCE`). Like the CDP client, the provider is
 * loaded lazily, only for a cell that can reference it; unlike the CDP client
 * it also lowers the cell and wraps its execution in the owner's natlang task.
 * The EvalDO owns exactly one `EvalNatlang` per owner and closes it whenever it
 * drops the notebook heap the instance was serving.
 */

/**
 * Conservative lexical precheck: natlang lowers cells mentioning `nl`,
 * `natlang` (also the provider's specifier `@workspace/natlang`), `iterateOn`,
 * or `Neuralese`, so a non-match guarantees the cell needs no provider and a
 * false positive only costs a load.
 */
const NATLANG_REFERENCE = /\b(?:nl|natlang|iterateOn|Neuralese)\b/;

export function cellMayReferenceNatlang(code: string): boolean {
  return NATLANG_REFERENCE.test(code);
}

export function requireNatlangProviderModule(
  source: string,
  loaded: unknown
): NatlangProviderModule {
  const exports =
    loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : undefined;
  const contractVersion = exports?.["NATLANG_PROVIDER_HOST_CONTRACT_VERSION"];
  if (contractVersion !== NATLANG_PROVIDER_HOST_CONTRACT_VERSION) {
    throw new Error(
      `eval: provider ${JSON.stringify(source)} uses host contract ${String(contractVersion)}; ` +
        `this runtime requires ${NATLANG_PROVIDER_HOST_CONTRACT_VERSION}`
    );
  }
  if (typeof exports?.["createEvalNatlang"] !== "function") {
    throw new Error(
      `eval: provider ${JSON.stringify(source)} (providers.natlang) does not export createEvalNatlang`
    );
  }
  return exports as unknown as NatlangProviderModule;
}

/** The single per-owner `EvalNatlang`, created on first use. */
export class OwnerNatlang {
  private instance: EvalNatlang | null = null;

  get current(): EvalNatlang | null {
    return this.instance;
  }

  /** The caller serializes runs, and creation is synchronous. */
  ensure(module: NatlangProviderModule, host: NatlangProviderHost): EvalNatlang {
    this.instance ??= module.createEvalNatlang(host);
    return this.instance;
  }

  /** Tear down the instance with the heap it served. */
  close(): void {
    const instance = this.instance;
    this.instance = null;
    instance?.close();
  }
}

export type NatlangLowering =
  | { ok: true; code: string; warnings: string }
  | { ok: false; failure: NatlangLoweringFailure };

export interface NatlangLoweringFailure {
  error: RpcFailure;
  failureKind: "user-code";
  failureCode: "natlang_lowering_failed";
}

function diagnosticLines(lowered: NatlangLoweredCell, fileName: string, severity: string) {
  return lowered.diagnostics
    .filter((diagnostic) => diagnostic.severity === severity)
    .map(
      (diagnostic) =>
        `${fileName}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}: ${diagnostic.message}`
    );
}

/**
 * Lower `nl` in one cell. Error diagnostics are a user-code failure carrying
 * their cell positions, and the cell is not executed; warnings are returned for
 * the cell's console.
 */
export function lowerNatlangCell(
  natlang: EvalNatlang,
  source: string,
  options: NatlangLowerOptions
): NatlangLowering {
  const lowered = natlang.lowerCell(source, options);
  const errors = diagnosticLines(lowered, options.fileName, "error");
  if (errors.length > 0) {
    return {
      ok: false,
      failure: {
        error: serializeRpcFailure(new Error(`natlang lowering failed:\n${errors.join("\n")}`)),
        failureKind: "user-code",
        failureCode: "natlang_lowering_failed",
      },
    };
  }
  const warnings = diagnosticLines(lowered, options.fileName, "warning");
  return {
    ok: true,
    code: lowered.code,
    warnings: warnings.map((line) => `[natlang] warning ${line}`).join("\n"),
  };
}

/** The calls a result reports, bounded; the surplus is counted, not hidden. */
export function natlangResult(
  calls: readonly EvalNatlangCallSummary[]
): EvalNatlangResult | undefined {
  if (calls.length === 0) return undefined;
  const kept = calls.slice(0, EVAL_NATLANG_RESULT_MAX_CALLS);
  const omitted = calls.length - kept.length;
  return { calls: kept, ...(omitted > 0 ? { omitted } : {}) };
}

export function isNatlangAmbientName(name: string): boolean {
  return (NATLANG_AMBIENT_NAMES as readonly string[]).includes(name);
}

/** `help("nl")` / `help("natlang")` text, owned by the provider. */
export function natlangHelp(natlang: EvalNatlang | null, name: string): unknown | undefined {
  if (!natlang || !isNatlangAmbientName(name)) return undefined;
  const help = (natlang.ambient.natlang as { help?: unknown } | null | undefined)?.help;
  if (typeof help !== "function") {
    throw new Error("eval: the natlang provider's `natlang` ambient does not export help()");
  }
  return { name, surface: "natlang", help: help.call(natlang.ambient.natlang) };
}

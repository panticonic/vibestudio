import type { EvalNatlangCallSummary } from "./eval.js";

/**
 * Exact ABI between the builtin EvalDO host and the dynamically loaded
 * workspace natlang provider (`providers.natlang` in meta/vibestudio.yml).
 * Bump this whenever either side's structural contract changes; a provider
 * built against another version must fail before it runs a cell.
 */
export const NATLANG_PROVIDER_HOST_CONTRACT_VERSION = 1 as const;

/** What the host hands the provider once per EvalDO owner. */
export interface NatlangProviderHost {
  /** workerd UNSAFE_EVAL newFunction: the same constructor the eval engine uses. */
  newFunction(body: string, name: string, ...argNames: string[]): (...args: unknown[]) => unknown;
  /** The eval's runtime bindings (rpc, workers, fs, vcs, gad, services, credentials, ...). */
  bindings: Readonly<Record<string, unknown>>;
  owner: {
    kind: "agent" | "panel" | "headless" | "user";
    objectKey: string;
    agentRef?: string;
    channelId?: string;
  };
}

export interface NatlangLoweredCell {
  usesNl: boolean;
  /** TS/TSX with nl lowered; unchanged when `diagnostics` has errors. */
  code: string;
  diagnostics: Array<{
    code: string;
    message: string;
    line: number;
    column: number;
    severity: "error" | "warning";
  }>;
}

export interface NatlangLowerOptions {
  fileName: string;
  jsx: boolean;
  /** Every ambient free-variable name in this cell's scope. */
  ambientNames: readonly string[];
  /** Current `scope` contents; the provider derives declarations from the values. */
  scopeValues: Record<string, unknown>;
}

export interface EvalNatlang {
  /**
   * Ambient values injected into the cell: `nl` (with `nl.__inline`), `natlang`,
   * and the internal `__natlang` that lowered code calls. The host injects every
   * key; only `nl`/`natlang` are listed in EVAL_AMBIENT_ONLY and help.
   */
  readonly ambient: { nl: unknown; natlang: unknown; __natlang: unknown };
  lowerCell(source: string, options: NatlangLowerOptions): NatlangLoweredCell;
  /**
   * Run one cell's execution inside the owner's natlang task. Aborting
   * `signal` stops running natlang calls (authoritative; no deadlines).
   * Returns the calls the cell made.
   */
  runCell<T>(
    execute: () => Promise<T>,
    options: { runId: string; signal: AbortSignal }
  ): Promise<{ value: T; calls: EvalNatlangCallSummary[] }>;
  close(): void;
}

/** The loaded provider module's required exports. */
export interface NatlangProviderModule {
  NATLANG_PROVIDER_HOST_CONTRACT_VERSION: number;
  createEvalNatlang(host: NatlangProviderHost): EvalNatlang;
}

/** Ambient names the provider documents (`__natlang` is lowering plumbing, hidden from help). */
export const NATLANG_AMBIENT_NAMES = ["nl", "natlang"] as const;

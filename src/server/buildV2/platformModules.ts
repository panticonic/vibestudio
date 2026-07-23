/**
 * Platform-module contract — the single registry of WORKSPACE (userland)
 * package names that the HOST build system depends on.
 *
 * The invariant this file enforces: host code must not scatter hardcoded
 * knowledge of workspace packages. Where the platform legitimately requires a
 * userland counterpart module (the runtime SDK, framework auto-mount helpers,
 * workerd shims), that requirement is declared HERE, once, with the exact
 * surface the host expects the module to provide and why the host needs it.
 *
 * Renaming or replacing one of these packages in the workspace is a breaking
 * platform-contract change: update the constant here and every builder use
 * follows.
 *
 * Related contracts that live elsewhere by necessity:
 *   - `packages/workspace/src/extensionRegistry.ts` — the host-generated
 *     extensions-registry barrel delivered into the runtime SDK package
 *     ({@link RUNTIME_MODULE}). It lives in `@vibestudio/shared` because the
 *     generator is called from the server outside the build system; the sink
 *     is discovered by an in-file directive, not a hardcoded path.
 */

// ---------------------------------------------------------------------------
// Runtime SDK
// ---------------------------------------------------------------------------

/**
 * `@workspace/runtime` — the workspace-side SDK that panels, workers, and
 * eval'd code import to talk to the host.
 *
 * Why the host requires it:
 *   - Panel/worker builds shim Node's `fs` / `fs/promises` to delegate to the
 *     runtime's RPC-backed filesystem (see `createFsShimPlugin`).
 *   - Worker builds that expose the runtime on the module map also register
 *     Node built-in shims and force-expose companion modules
 *     ({@link WORKER_RUNTIME_COMPANION_MODULES}) so eval'd code gets a working
 *     `require()` surface (see `generateExposeModuleCode`).
 *   - Workspace *app* renderers get a host-generated stub in its place
 *     (see `createAppRuntimeShimPlugin`) — apps must not bootstrap panel APIs.
 *   - Eval library builds keep it external so it resolves at runtime to the
 *     hosting sandbox's SDK instance instead of being re-bundled.
 *
 * What the host expects it to export:
 *   - A named `fs` export: an object/Proxy of async Node-fs-shaped methods
 *     (`readFile`, `writeFile`, `readdir`, `stat`, ...) — the fs shim and the
 *     worker `fs` module-map registration destructure methods off it.
 *   - Its panel entry (condition `vibestudio-panel`) self-initializes on load; its
 *     worker entry (conditions `worker`/`workerd`) must NOT self-initialize.
 */
export const RUNTIME_MODULE = "@workspace/runtime";

/**
 * `@workspace/cdp-client` — Chrome-DevTools-Protocol client used by agent
 * tooling inside the eval sandbox.
 *
 * Why the host requires it: worker builds that expose {@link RUNTIME_MODULE}
 * force this module onto `__vibestudioModuleMap__` too, so sandboxed eval code can
 * `require("@workspace/cdp-client")` without declaring it in the worker's own
 * manifest. The host registers the whole module namespace; no specific named
 * export is consumed by host code itself.
 */
export const CDP_CLIENT_MODULE = "@workspace/cdp-client";

/**
 * Companion modules the host force-exposes on the worker module map whenever a
 * worker exposes {@link RUNTIME_MODULE}. Order is preserved in the generated
 * expose entry (after the manifest-declared modules).
 */
export const WORKER_RUNTIME_COMPANION_MODULES: readonly string[] = [CDP_CLIENT_MODULE];

// ---------------------------------------------------------------------------
// Terminal (Ink) worker shims
// ---------------------------------------------------------------------------

/**
 * `@workspace/terminal-shim` — workerd-compatible replacements for npm
 * packages that break inside workerd, used by Ink terminal-worker builds
 * (see `createTerminalWorkerAliasPlugin`).
 *
 * Why the host requires it: Ink and its dependencies import `yoga-layout`,
 * `signal-exit`, and `terminal-size`, none of which work in a workerd isolate.
 * The builder rewrites those imports to this package's subpath exports.
 *
 * What the host expects it to export (subpaths declared in the package's
 * `exports` map, each drop-in compatible with the npm module it replaces):
 *   - `./yoga`               — synchronous yoga-layout loader (default export:
 *                              initialized Yoga instance, wasm supplied by
 *                              workerd as a `yoga.wasm` module binding).
 *   - `./node/signal-exit`   — `signal-exit`-shaped API (`onExit`, ...).
 *   - `./node/terminal-size` — `terminal-size`-shaped API.
 */
export const TERMINAL_SHIM_MODULE = "@workspace/terminal-shim";

/** Subpath specifier the builder substitutes for Ink's `yoga-layout` import. */
export const TERMINAL_SHIM_YOGA = `${TERMINAL_SHIM_MODULE}/yoga`;

/** Subpath specifier the builder substitutes for `signal-exit`. */
export const TERMINAL_SHIM_SIGNAL_EXIT = `${TERMINAL_SHIM_MODULE}/node/signal-exit`;

/** Subpath specifier the builder substitutes for `terminal-size`. */
export const TERMINAL_SHIM_TERMINAL_SIZE = `${TERMINAL_SHIM_MODULE}/node/terminal-size`;

// ---------------------------------------------------------------------------
// Framework auto-mount modules
// ---------------------------------------------------------------------------

/**
 * A framework's workspace counterpart module.
 *
 * Why the host requires it: for panels without a hand-written mount, the
 * builder generates an entry wrapper that imports the user module and asks the
 * framework module to mount it (see `adapters/*.generateEntry`). The same
 * module name doubles as the dependency marker for framework auto-detection
 * (see `templateResolver.detectFrameworkFromDeps`): a unit that depends on the
 * module gets the matching adapter.
 *
 * What the host expects the module to export:
 *   - `shouldAutoMount(userModule): boolean`
 *   - the framework-specific `autoMountExport` function, called with the user
 *     module namespace when `shouldAutoMount` returns true.
 *
 * A unit may substitute its own implementation of this contract via the
 * `vibestudio.frameworkModule` manifest field (a bare specifier); the generated
 * entry then imports the same two functions from that module instead.
 */
export interface FrameworkModuleContract {
  /** Adapter id (see `adapters/index.ts`). */
  readonly framework: string;
  /** Workspace dependency whose presence selects this framework. */
  readonly module: string;
  /** Focused auto-mount module imported by the generated entry. */
  readonly entryModule: string;
  /** Name of the mount function the generated entry calls. */
  readonly autoMountExport: string;
}

/** Export every framework module must provide alongside its mount function. */
export const SHOULD_AUTO_MOUNT_EXPORT = "shouldAutoMount";

export const REACT_FRAMEWORK_MODULE = "@workspace/react";
export const REACT_FRAMEWORK_ENTRY_MODULE = "@workspace/react/auto-mount";
export const SVELTE_FRAMEWORK_MODULE = "@workspace/svelte";

/**
 * Ordered list of framework contracts. Order is the auto-detection priority:
 * the first entry whose module appears in a unit's dependencies wins.
 */
export const FRAMEWORK_MODULES: readonly FrameworkModuleContract[] = [
  {
    framework: "react",
    module: REACT_FRAMEWORK_MODULE,
    entryModule: REACT_FRAMEWORK_ENTRY_MODULE,
    autoMountExport: "autoMountReactPanel",
  },
  {
    framework: "svelte",
    module: SVELTE_FRAMEWORK_MODULE,
    entryModule: SVELTE_FRAMEWORK_MODULE,
    autoMountExport: "autoMountSveltePanel",
  },
];

/** Default entry module for a framework id, or null for frameworks without one (vanilla). */
export function frameworkEntryModule(framework: string): string | null {
  return (
    FRAMEWORK_MODULES.find((contract) => contract.framework === framework)?.entryModule ?? null
  );
}

/**
 * Detect a unit's framework from its dependencies: the first framework whose
 * counterpart module is declared wins; null when none matches (vanilla).
 */
export function detectFrameworkFromDependencies(
  dependencies: Record<string, string>
): string | null {
  for (const contract of FRAMEWORK_MODULES) {
    if (contract.module in dependencies) return contract.framework;
  }
  return null;
}

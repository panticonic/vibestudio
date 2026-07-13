import { buildMethods, type LibraryBuildTarget } from "../build.js";
import {
  createTypedServiceClient,
  type ServiceCallFn,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

export type BuildServiceClient = TypedServiceClient<typeof buildMethods>;
export interface EvalImportLoader {
  (specifier: string, ref: string | undefined, externals: string[]): Promise<string>;
  /**
   * Report whether a bare specifier belongs to a manifest-declared workspace
   * unit. Sandboxes use this to auto-load unscoped units (for example a worker
   * named `local-worker`) without misclassifying every unknown npm package as a
   * workspace build.
   */
  resolveWorkspaceImport(specifier: string): Promise<boolean>;
}

export interface EvalImportLoaderOptions {
  /**
   * Workspace ref used for automatic imports and package-manager-style
   * `workspace:*` aliases. Eval supplies its caller's `ctx:<contextId>` so
   * imports observe the same working state as runtime/fs/vcs operations.
   * Panel sandboxes may omit it to retain the build service's `main` default.
   */
  defaultWorkspaceRef?: string | (() => string | undefined);
}

export function createBuildServiceClient(call: ServiceCallFn): BuildServiceClient {
  return createTypedServiceClient("build", buildMethods, call);
}

export function requireBuildBundleResult(result: unknown, message: string): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "bundle" in result &&
    typeof result.bundle === "string"
  ) {
    return result.bundle;
  }
  throw new Error(message);
}

function parsePackageQualifiedNpmRef(value: string): { specifier: string; version: string } | null {
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const specifier = value.slice(0, at);
  if (!specifier.includes("/") && specifier.startsWith("@")) return null;
  return { specifier, version: value.slice(at + 1) || "latest" };
}

function npmRefToVersion(specifier: string, ref: string): string {
  const value = ref.slice("npm:".length) || "latest";
  const qualified = parsePackageQualifiedNpmRef(value);
  if (!qualified) return value;
  if (qualified.specifier !== specifier) {
    throw new Error(
      `npm import ${JSON.stringify(specifier)} points at ${JSON.stringify(qualified.specifier)}. ` +
        `The imports map key is the package name; use ` +
        `imports: { ${JSON.stringify(qualified.specifier)}: ${JSON.stringify(`npm:${qualified.version}`)} } instead.`
    );
  }
  return qualified.version;
}

/**
 * Build the on-demand import loader for a sandbox host. `target` selects the
 * module resolution conditions for workspace library bundles and MUST match the
 * host's execution environment — `worker` for the eval sandbox (a workerd DO),
 * `panel` for a panel-hosted sandbox. No default: pick deliberately.
 */
export function createEvalImportLoader(
  build: BuildServiceClient,
  target: LibraryBuildTarget,
  options: EvalImportLoaderOptions = {}
): EvalImportLoader {
  const defaultWorkspaceRef = () =>
    typeof options.defaultWorkspaceRef === "function"
      ? options.defaultWorkspaceRef()
      : options.defaultWorkspaceRef;
  const workspaceRef = (ref: string | undefined): string | undefined => {
    // `workspace:*`/`workspace:^`/`workspace:~` are the natural pnpm/npm
    // spellings users put in dependency maps. In eval they mean the same
    // thing as an omitted workspace ref: build this sandbox's working view.
    if (
      ref === undefined ||
      ref === "latest" ||
      ref === "workspace" ||
      ref.startsWith("workspace:")
    ) {
      return defaultWorkspaceRef();
    }
    return ref;
  };
  const loadImport = async (specifier: string, ref: string | undefined, externals: string[]) => {
    if (ref?.startsWith("npm:")) {
      const version = npmRefToVersion(specifier, ref);
      const result = await build.getBuildNpm(specifier, version, externals);
      return result.bundle;
    }

    const result = await build.getBuild(specifier, workspaceRef(ref), {
      library: true,
      externals,
      libraryTarget: target,
    });
    return requireBuildBundleResult(
      result,
      `Build service returned a full build for library import: ${specifier}`
    );
  };

  const resolveWorkspaceImport = async (specifier: string): Promise<boolean> => {
    // Provenance resolution understands exact package names, workspace-relative
    // paths, and unique unit basenames. Probe the package root so declared
    // export subpaths ("pkg/subpath") are recognized without building them.
    const packageRoot = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : (specifier.split("/")[0] ?? specifier);
    const result = await build.inspectBuildProvenance(packageRoot);
    return result.found && result.ambiguous !== true;
  };

  return Object.assign(loadImport, { resolveWorkspaceImport });
}

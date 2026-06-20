import { buildMethods, type LibraryBuildTarget } from "./serviceSchemas/build.js";
import {
  createTypedServiceClient,
  type ServiceCallFn,
  type TypedServiceClient,
} from "./typedServiceClient.js";

export type BuildServiceClient = TypedServiceClient<typeof buildMethods>;
export type EvalImportLoader = (
  specifier: string,
  ref: string | undefined,
  externals: string[]
) => Promise<string>;

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

/**
 * Build the on-demand import loader for a sandbox host. `target` selects the
 * module resolution conditions for workspace library bundles and MUST match the
 * host's execution environment — `worker` for the eval sandbox (a workerd DO),
 * `panel` for a panel-hosted sandbox. No default: pick deliberately.
 */
export function createEvalImportLoader(
  build: BuildServiceClient,
  target: LibraryBuildTarget
): EvalImportLoader {
  return async (specifier, ref, externals) => {
    if (ref?.startsWith("npm:")) {
      const version = ref.slice(4) || "latest";
      const result = await build.getBuildNpm(specifier, version, externals);
      return result.bundle;
    }

    const result = await build.getBuild(specifier, ref, {
      library: true,
      externals,
      libraryTarget: target,
    });
    return requireBuildBundleResult(
      result,
      `Build service returned a full build for library import: ${specifier}`
    );
  };
}

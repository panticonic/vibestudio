import { NODE_ESM_COMPAT_BANNER } from "./build-artifact-contracts.mjs";
import { NATIVE_WORKSPACE_ENTRIES } from "./server-runtime-artifacts.mjs";

/** Self-contained executable closures; launchers never resolve mutable package outputs. */
export function nativeWorkspaceArtifactConfigs({ isDev = false, logOverride = {} } = {}) {
  return [
    [
      "packages/process-adapter/src/isolation/workspaceChild.ts",
      NATIVE_WORKSPACE_ENTRIES.workspaceSupervisor,
    ],
    ["packages/extension-host/src/childRuntime.ts", NATIVE_WORKSPACE_ENTRIES.extensionChild],
  ].map(([entry, filename]) => ({
    entryPoints: [entry],
    outfile: `dist/${filename}`,
    bundle: true,
    tsconfig: "tsconfig.json",
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["electron"],
    banner: { js: NODE_ESM_COMPAT_BANNER },
    sourcemap: isDev,
    minify: !isDev,
    logOverride,
  }));
}

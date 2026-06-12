/**
 * SandboxConfig factory for panel contexts.
 *
 * Worker and Node.js factories live in @workspace/agentic-session.
 */
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { buildMethods } from "@natstack/shared/serviceSchemas/build";
import type { SandboxConfig } from "./types.js";
interface RpcLike {
    call(target: string, method: string, args: unknown[]): Promise<unknown>;
}
/**
 * Create a SandboxConfig for panel contexts.
 *
 * Extracts the inline wiring that was previously in chat/index.tsx:248-263
 * into a reusable function. Both workspace and npm imports go through RPC
 * to the build service on the main process.
 */
export function createPanelSandboxConfig(rpc: RpcLike): SandboxConfig {
    const build = createTypedServiceClient("build", buildMethods, (svc, method, args) =>
        rpc.call("main", `${svc}.${method}`, args)
    );
    return {
        rpc: { call: (t: string, m: string, args: unknown[]) => rpc.call(t, m, args) },
        loadImport: async (specifier: string, ref: string | undefined, externals: string[]) => {
            if (ref?.startsWith("npm:")) {
                const version = ref.slice(4) || "latest";
                const result = await build.getBuildNpm(specifier, version, externals);
                return result.bundle;
            }
            const result = await build.getBuild(specifier, ref, { library: true, externals });
            if (!("bundle" in result)) {
                throw new Error(`Build service returned a full build for library import: ${specifier}`);
            }
            return result.bundle;
        },
    };
}

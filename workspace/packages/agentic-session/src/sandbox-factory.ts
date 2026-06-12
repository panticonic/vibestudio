import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { buildMethods } from "@natstack/shared/serviceSchemas/build";
import type { SandboxConfig } from "@workspace/agentic-core";
interface RpcLike {
    call(target: string, method: string, args: unknown[]): Promise<unknown>;
}
export function createRpcSandboxConfig(rpc: RpcLike): SandboxConfig {
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

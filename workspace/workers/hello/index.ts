/**
 * Hello Worker — sample workerd worker demonstrating Vibestudio runtime integration.
 *
 * Shows: fs access, workspace tree, and basic HTTP handling.
 */

import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

/**
 * Fixed, deliberately non-secret diagnostic binding used by docs/system probes.
 * Never generalize this to accept arbitrary keys or return the full WorkerEnv.
 */
export function readNonSecretProbe(env: WorkerEnv): { value: string | null } {
  return {
    value: typeof env["NON_SECRET_PROBE"] === "string" ? env["NON_SECRET_PROBE"] : null,
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    // Expose one fixed safe value so callers can distinguish "the host accepted
    // env configuration" from "the running worker actually observed it".
    runtime.rpc.expose("readNonSecretProbe", () => readNonSecretProbe(env));

    // Handle incoming RPC calls
    const rpcResponse = await handleWorkerRpc(runtime, request);
    if (rpcResponse) return rpcResponse;

    const url = new URL(request.url);

    if (url.pathname === "/tree") {
      const tree = await runtime.workspace.sourceTree();
      return new Response(JSON.stringify(tree, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/readfile") {
      const filePath = url.searchParams.get("path") ?? "/package.json";
      try {
        const content = await runtime.fs.readFile(filePath, "utf8");
        return new Response(content as string, {
          headers: { "Content-Type": "text/plain" },
        });
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    }

    return new Response(`Hello from Vibestudio Worker!\n\nRPC:\n  readNonSecretProbe - returns only NON_SECRET_PROBE\n\nRoutes:\n  /tree - workspace tree\n  /readfile?path=/package.json - read a file\n`, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

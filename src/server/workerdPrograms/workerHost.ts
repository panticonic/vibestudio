import { serializeRpcFailure, deserializeRpcFailure } from "@vibestudio/rpc";
import { WORKER_EXECUTABLE_VERSION_HEADER } from "../workerExecutableDispatch.js";
import {
  gatewayFetch,
  loadedNetworkPolicy,
  type CelldWorkerCode,
  type HostProgramEnv,
} from "./celldRuntime.js";

interface WorkerHostEnv extends HostProgramEnv {
  LOADER: WorkerLoader;
}

interface WorkerCodePayload extends WorkerLoaderWorkerCode {
  callerId: string;
}

const workerHost: ExportedHandler<WorkerHostEnv> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const name = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!name) {
      return new Response("worker-host: missing instance name", { status: 400 });
    }

    const version = request.headers.get(WORKER_EXECUTABLE_VERSION_HEADER);
    if (!version) return new Response("worker-host: missing worker admission", { status: 400 });
    const loaderHeaders = { "X-Vibestudio-Loader-Secret": env.WORKERD_LOADER_SECRET };

    const identity = `${name}@${version}`;
    try {
      const stub = env.LOADER.get(identity, async (): Promise<CelldWorkerCode> => {
        const codeResponse = await gatewayFetch(
          env,
          `/_workercode/${encodeURIComponent(name)}?version=${encodeURIComponent(version)}`,
          { headers: loaderHeaders }
        );
        if (!codeResponse.ok) {
          const failure = (await codeResponse.json()) as {
            error: import("@vibestudio/rpc").RpcFailure;
          };
          throw deserializeRpcFailure(failure.error);
        }
        const code = (await codeResponse.json()) as WorkerCodePayload;
        return {
          compatibilityDate: code.compatibilityDate,
          compatibilityFlags: code.compatibilityFlags,
          mainModule: code.mainModule,
          modules: code.modules,
          env: code.env,
          ...loadedNetworkPolicy(code.callerId),
        };
      });

      // Strip the instance-name prefix so the loaded worker sees /__rpc etc.
      const rest = `/${parts.slice(1).join("/")}`;
      const forwardUrl = new URL(rest, url.origin);
      forwardUrl.search = url.search;
      return await stub.getEntrypoint().fetch(new Request(forwardUrl, request));
    } catch (error) {
      return Response.json({ error: serializeRpcFailure(error) }, { status: 500 });
    }
  },
};

export default workerHost;

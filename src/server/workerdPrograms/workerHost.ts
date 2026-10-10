import { serializeRpcFailure, deserializeRpcFailure } from "@vibestudio/rpc";
import { WORKER_EXECUTABLE_VERSION_HEADER } from "../workerExecutableDispatch.js";
import { WorkerEntrypoint } from "cloudflare:workers";

interface EgressProps {
  id: string;
}

interface WorkerHostEnv {
  EGRESS: Fetcher;
  GATEWAY: Fetcher;
  LOADER: WorkerLoader;
  WORKERD_EGRESS_SECRET: string;
  WORKERD_LOADER_SECRET: string;
}

interface WorkerCodePayload extends WorkerLoaderWorkerCode {
  callerId: string;
}

type EgressExports = Cloudflare.Exports & {
  EgressGateway(options: { props: EgressProps }): Fetcher;
};

function egressBinding(ctx: ExecutionContext, id: string): Fetcher {
  const exports = ctx.exports as EgressExports;
  return exports.EgressGateway({ props: { id } });
}

export class EgressGateway extends WorkerEntrypoint<WorkerHostEnv, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("X-Vibestudio-Egress-Caller", this.ctx.props.id);
    headers.set("X-Vibestudio-Egress-Secret", this.env.WORKERD_EGRESS_SECRET);
    return this.env.EGRESS.fetch(new Request(request, { headers }));
  }
}

interface ActiveSelection {
  requests: number;
  failure?: import("@vibestudio/rpc").RpcFailure;
}

// Own only concurrent selections. WorkerLoader remains the sole immutable-code cache.
const activeSelections = new Map<string, ActiveSelection>();

const workerHost: ExportedHandler<WorkerHostEnv> = {
  async fetch(request, env, ctx): Promise<Response> {
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
    const selection: ActiveSelection = activeSelections.get(identity) ?? { requests: 0 };
    activeSelections.set(identity, selection);
    selection.requests++;
    try {
      const stub = env.LOADER.get(identity, async () => {
        try {
          const codeResponse = await env.GATEWAY.fetch(
            new Request(
              `http://gateway/_workercode/${encodeURIComponent(name)}?version=${encodeURIComponent(version)}`,
              {
                headers: loaderHeaders,
              }
            )
          );
          if (!codeResponse.ok) {
            const failure = (await codeResponse.json()) as {
              error: import("@vibestudio/rpc").RpcFailure;
            };
            selection.failure = failure.error;
            throw deserializeRpcFailure(failure.error);
          }
          const code = (await codeResponse.json()) as WorkerCodePayload;
          return {
            compatibilityDate: code.compatibilityDate,
            compatibilityFlags: code.compatibilityFlags,
            mainModule: code.mainModule,
            modules: code.modules,
            env: code.env,
            globalOutbound: egressBinding(ctx, code.callerId),
          };
        } catch (error) {
          selection.failure ??= serializeRpcFailure(error);
          throw error;
        }
      });

      // Strip the instance-name prefix so the loaded worker sees /__rpc etc.
      const rest = `/${parts.slice(1).join("/")}`;
      const forwardUrl = new URL(rest, url.origin);
      forwardUrl.search = url.search;
      return await stub.getEntrypoint().fetch(new Request(forwardUrl, request));
    } catch (error) {
      return Response.json(
        { error: selection.failure ?? serializeRpcFailure(error) },
        { status: 500 }
      );
    } finally {
      if (--selection.requests === 0) activeSelections.delete(identity);
    }
  },
};

export default workerHost;

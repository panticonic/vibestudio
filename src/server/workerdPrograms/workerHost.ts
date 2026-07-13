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

const workerHost: ExportedHandler<WorkerHostEnv> = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const name = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!name) {
      return new Response("worker-host: missing instance name", { status: 400 });
    }

    const loaderHeaders = { "X-Vibestudio-Loader-Secret": env.WORKERD_LOADER_SECRET };
    const versionResponse = await env.GATEWAY.fetch(
      new Request(`http://gateway/_workerversion/${encodeURIComponent(name)}`, {
        headers: loaderHeaders,
      })
    );
    if (versionResponse.status === 404) {
      return new Response(`Worker not found: ${name}`, { status: 404 });
    }
    if (versionResponse.status === 503) {
      return new Response("worker-host: code warming", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }
    if (!versionResponse.ok) {
      return new Response(`worker-host: version lookup failed (${versionResponse.status})`, {
        status: 502,
      });
    }
    const { version } = (await versionResponse.json()) as { version: string };

    const stub = env.LOADER.get(`${name}@${version}`, async () => {
      const codeResponse = await env.GATEWAY.fetch(
        new Request(`http://gateway/_workercode/${encodeURIComponent(name)}`, {
          headers: loaderHeaders,
        })
      );
      if (!codeResponse.ok) {
        throw new Error(`worker-host: code fetch failed (${codeResponse.status})`);
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
    });

    // Strip the instance-name prefix so the loaded worker sees /__rpc etc.
    const rest = `/${parts.slice(1).join("/")}`;
    const forwardUrl = new URL(rest, url.origin);
    forwardUrl.search = url.search;
    try {
      return await stub.getEntrypoint().fetch(new Request(forwardUrl, request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(503)")) {
        return new Response("worker-host: code warming", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }
      throw error;
    }
  },
};

export default workerHost;

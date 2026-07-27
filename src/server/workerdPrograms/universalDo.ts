import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface EgressProps {
  id: string;
}

interface UniversalDoEnv {
  EGRESS: Fetcher;
  GATEWAY: Fetcher;
  LOADER: WorkerLoader;
  WORKERD_EGRESS_SECRET: string;
  WORKERD_LOADER_SECRET: string;
}

interface DurableObjectCodePayload extends WorkerLoaderWorkerCode {
  wasmModules?: Record<string, string>;
}

interface LoadedFacetClass {
  version: string;
  class: DurableObjectClass;
}

type EgressExports = Cloudflare.Exports & {
  EgressGateway(options: { props: EgressProps }): Fetcher;
};

function egressBinding(ctx: DurableObjectState, id: string): Fetcher {
  const exports = ctx.exports as EgressExports;
  return exports.EgressGateway({ props: { id } });
}

export class EgressGateway extends WorkerEntrypoint<UniversalDoEnv, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("X-Vibestudio-Egress-Caller", this.ctx.props.id);
    headers.set("X-Vibestudio-Egress-Secret", this.env.WORKERD_EGRESS_SECRET);
    return this.env.EGRESS.fetch(new Request(request, { headers }));
  }
}

function decodeKey(encoded: string): { source: string; className: string; userKey: string } {
  const parts = encoded.split("|");
  return {
    source: decodeURIComponent(parts[0] ?? ""),
    className: decodeURIComponent(parts[1] ?? ""),
    userKey: decodeURIComponent(parts[2] ?? ""),
  };
}

export class UniversalDO extends DurableObject<UniversalDoEnv> {
  private loadedFacet: LoadedFacetClass | null = null;
  private loadedFacetFlight: { version: string; promise: Promise<LoadedFacetClass> } | null = null;

  private async loadFacetClass(args: {
    source: string;
    className: string;
    userKey: string;
    version: string;
    loaderHeaders: HeadersInit;
    egressIdentity: string;
  }): Promise<LoadedFacetClass> {
    if (this.loadedFacet?.version === args.version) return this.loadedFacet;
    if (this.loadedFacetFlight?.version === args.version) return this.loadedFacetFlight.promise;

    if (this.loadedFacet) {
      this.ctx.facets.abort("do", new Error("Runtime image advanced"));
      this.loadedFacet = null;
    }

    const promise = (async (): Promise<LoadedFacetClass> => {
      const identity = `${args.source}:${args.className}`;
      const codeResponse = await this.env.GATEWAY.fetch(
        new Request(
          `http://gateway/_docode/${encodeURIComponent(args.source)}/${encodeURIComponent(args.className)}` +
            `?objectKey=${encodeURIComponent(args.userKey)}`,
          { headers: args.loaderHeaders }
        )
      );
      if (!codeResponse.ok) {
        throw new Error(
          `universal-do: code fetch failed for ${identity}/${args.userKey}@${args.version} ` +
            `(${codeResponse.status})`
        );
      }
      const code = (await codeResponse.json()) as DurableObjectCodePayload;
      const modules = { ...code.modules };
      if (code.wasmModules) {
        for (const [name, encodedModule] of Object.entries(code.wasmModules)) {
          const binary = atob(encodedModule);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
          }
          modules[name] = { wasm: bytes.buffer };
        }
      }
      const worker = this.env.LOADER.load({
        compatibilityDate: code.compatibilityDate,
        compatibilityFlags: code.compatibilityFlags,
        mainModule: code.mainModule,
        modules,
        env: code.env,
        globalOutbound: egressBinding(this.ctx, args.egressIdentity),
      });
      return {
        version: args.version,
        class: worker.getDurableObjectClass(args.className),
      };
    })();
    const flight = { version: args.version, promise };
    this.loadedFacetFlight = flight;
    try {
      const loaded = await promise;
      this.loadedFacet = loaded;
      return loaded;
    } finally {
      if (this.loadedFacetFlight === flight) this.loadedFacetFlight = null;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const encodedKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!encodedKey) {
      return new Response("universal-do: missing key", { status: 400 });
    }
    const { source, className, userKey } = decodeKey(encodedKey);
    if (!source || !className) {
      return new Response("universal-do: bad key", { status: 400 });
    }

    if (parts[1] === "__vibestudio_retire") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== this.env.WORKERD_LOADER_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      this.ctx.facets.abort("do", new Error("Runtime entity retired"));
      this.loadedFacet = null;
      this.loadedFacetFlight = null;
      return new Response(null, { status: 204 });
    }

    if (parts[1] === "__vibestudio_fault_abort") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== this.env.WORKERD_LOADER_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      // Abort only the loaded userland object. Its SQLite storage and the
      // universal host stay live, so the next ordinary request constructs a
      // genuinely fresh vessel over the same durable state.
      this.ctx.facets.abort("do", new Error("System-test injected vessel crash"));
      return new Response(null, { status: 204 });
    }

    const identity = `${source}:${className}`;
    const egressIdentity = `do:${identity}:${userKey}`;
    const loaderHeaders = { "X-Vibestudio-Loader-Secret": this.env.WORKERD_LOADER_SECRET };
    const versionResponse = await this.env.GATEWAY.fetch(
      new Request(
        `http://gateway/_doversion/${encodeURIComponent(source)}/${encodeURIComponent(className)}` +
          `?objectKey=${encodeURIComponent(userKey)}`,
        { headers: loaderHeaders }
      )
    );
    if (versionResponse.status === 404) {
      return new Response(`DO class not found: ${identity}`, { status: 404 });
    }
    if (versionResponse.status === 503) {
      return new Response("universal-do: code warming", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }
    if (!versionResponse.ok) {
      return new Response(`universal-do: version lookup failed (${versionResponse.status})`, {
        status: 502,
      });
    }
    const { version } = (await versionResponse.json()) as { version: string };

    const loaded = await this.loadFacetClass({
      source,
      className,
      userKey,
      version,
      loaderHeaders,
      egressIdentity,
    });

    // One logical DO per host object means one constant facet name. Keeping it
    // stable also makes clone/delete operations portable across host objects.
    const facet = this.ctx.facets.get("do", () => ({ class: loaded.class }));

    const innerRest = parts.slice(1);
    const innerUrl = new URL(
      `/${encodeURIComponent(userKey)}${innerRest.length ? `/${innerRest.join("/")}` : ""}`,
      url.origin
    );
    innerUrl.search = url.search;
    try {
      return await facet.fetch(new Request(innerUrl, request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(503)")) {
        return new Response("universal-do: code warming", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }
      throw error;
    }
  }
}

const universalDoHost: ExportedHandler = {
  fetch(): Response {
    return new Response("universal-do host");
  },
};

export default universalDoHost;

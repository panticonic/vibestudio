import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DO_EXECUTABLE_VERSION_HEADER } from "./executableVersion.js";

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
  version: string;
  egressIdentity: string | null;
  wasmModules?: Record<string, string>;
}

interface LoadedFacetClass {
  version: string;
  class: DurableObjectClass;
}

async function fetchLoader(gateway: Fetcher, request: Request): Promise<Response> {
  try {
    return await gateway.fetch(request);
  } catch (error) {
    console.error(
      "Durable Object loader request failed",
      new URL(request.url).pathname,
      error instanceof Error ? (error.stack ?? error.message) : error
    );
    throw error;
  }
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
  private loadFacetClass(args: {
    source: string;
    className: string;
    userKey: string;
    version: string;
    loaderHeaders: HeadersInit;
  }): LoadedFacetClass {
    if (this.loadedFacet?.version === args.version) return this.loadedFacet;
    if (this.loadedFacet) {
      this.ctx.facets.abort("do", new Error("Runtime image advanced"));
      this.loadedFacet = null;
    }

    // The loader owns one immutable executable unit per exact incarnation.
    // Objects still own separate facets, SQLite storage, and lifecycle; a live
    // update selects another unit without replacing a sibling's assigned code.
    const unitKey = JSON.stringify([args.source, args.className, args.version]);
    const worker = this.env.LOADER.get(unitKey, async () => {
      const startedAt = performance.now();
      const identity = `${args.source}:${args.className}`;
      const codeResponse = await fetchLoader(
        this.env.GATEWAY,
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
      const fetchedAt = performance.now();
      const code = (await codeResponse.json()) as DurableObjectCodePayload;
      if (code.version !== args.version) {
        throw new Error(
          `universal-do: executable changed before loading ${identity}/${args.userKey}`
        );
      }
      if (
        code.egressIdentity !== null &&
        (typeof code.egressIdentity !== "string" || code.egressIdentity.length === 0)
      ) {
        throw new Error(`universal-do: executable ${identity} has no network identity`);
      }
      const modules = { ...code.modules };
      if (code.wasmModules) {
        for (const [name, encodedModule] of Object.entries(code.wasmModules)) {
          const binary = atob(encodedModule);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++)
            bytes[index] = binary.charCodeAt(index);
          modules[name] = { wasm: bytes.buffer };
        }
      }
      console.info(
        "Durable Object executable loaded",
        JSON.stringify({
          source: args.source,
          className: args.className,
          objectKey: args.userKey,
          version: args.version,
          fetchMs: fetchedAt - startedAt,
          decodeMs: performance.now() - fetchedAt,
        })
      );
      return {
        compatibilityDate: code.compatibilityDate,
        compatibilityFlags: code.compatibilityFlags,
        mainModule: code.mainModule,
        modules,
        env: code.env,
        globalOutbound:
          code.egressIdentity === null ? null : egressBinding(this.ctx, code.egressIdentity),
      };
    });
    this.loadedFacet = {
      version: args.version,
      class: worker.getDurableObjectClass(args.className),
    };
    return this.loadedFacet;
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

    if (parts[1] === "__vibestudio_retire" || parts[1] === "__vibestudio_restart") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== this.env.WORKERD_LOADER_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      this.ctx.facets.abort(
        "do",
        new Error(
          parts[1] === "__vibestudio_restart"
            ? "Runtime entity restarted"
            : "Runtime entity retired"
        )
      );
      this.loadedFacet = null;
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
    const loaderHeaders = { "X-Vibestudio-Loader-Secret": this.env.WORKERD_LOADER_SECRET };
    const version = request.headers.get(DO_EXECUTABLE_VERSION_HEADER);
    if (!version) return new Response("universal-do: missing executable identity", { status: 400 });

    const activatesFacet = this.loadedFacet?.version !== version;
    const activationStartedAt = performance.now();
    const loaded = this.loadFacetClass({
      source,
      className,
      userKey,
      version,
      loaderHeaders,
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
    const dispatchStartedAt = performance.now();
    let completed = false;
    try {
      const response = await facet.fetch(new Request(innerUrl, request));
      completed = true;
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(503)")) {
        return new Response("universal-do: code warming", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }
      console.error(
        "Durable Object facet request failed",
        identity,
        userKey,
        innerRest.join("/"),
        error instanceof Error ? (error.stack ?? error.message) : error
      );
      throw error;
    } finally {
      if (activatesFacet) {
        console.info(
          "Durable Object first activation",
          JSON.stringify({
            source,
            className,
            objectKey: userKey,
            version,
            method: innerRest.join("/"),
            loadMs: dispatchStartedAt - activationStartedAt,
            firstFetchMs: performance.now() - dispatchStartedAt,
            completed,
          })
        );
      }
    }
  }
}

const universalDoHost: ExportedHandler = {
  fetch(): Response {
    return new Response("universal-do host");
  },
};

export default universalDoHost;

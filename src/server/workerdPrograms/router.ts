import { DIRECT_AUTHORITY_ACCEPTED_AT_HEADER } from "@vibestudio/rpc";

type RouterBinding = string | Fetcher | DurableObjectNamespace | Readonly<Record<string, string>>;

interface RouterEnv extends Record<string, RouterBinding> {
  WORKERD_DISPATCH_SECRET: string;
  WORKERD_DO_BINDINGS: Readonly<Record<string, string>>;
  WORKERD_GATEWAY_TOKEN: string;
  WORKER_HOST: Fetcher;
  UNIVERSAL_DO: DurableObjectNamespace;
}

function isDurableObjectNamespace(
  binding: RouterBinding | undefined
): binding is DurableObjectNamespace {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "idFromName" in binding &&
    typeof binding.idFromName === "function" &&
    "get" in binding &&
    typeof binding.get === "function"
  );
}

const router: ExportedHandler<RouterEnv> = {
  async fetch(request, env): Promise<Response> {
    const expectedAuth = `Bearer ${env.WORKERD_GATEWAY_TOKEN}`;
    if (request.headers.get("Authorization") !== expectedAuth) {
      return new Response("Unauthorized", { status: 401 });
    }

    const strippedHeaders = new Headers(request.headers);
    strippedHeaders.delete("Authorization");
    strippedHeaders.delete("X-Vibestudio-Dispatch-Secret");
    strippedHeaders.delete(DIRECT_AUTHORITY_ACCEPTED_AT_HEADER);
    for (const name of Array.from(strippedHeaders.keys())) {
      if (name.toLowerCase().startsWith("x-internal-")) strippedHeaders.delete(name);
    }
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const prefix = parts[0] ?? "";

    if (prefix === "__vibestudio_workerd_ready") {
      return new Response(null, { status: 204 });
    }
    if (
      (prefix === "_w" || prefix === "_u") &&
      request.headers.get("X-Vibestudio-Dispatch-Secret") !== env.WORKERD_DISPATCH_SECRET
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    if (prefix === "_w" || prefix === "_u") {
      strippedHeaders.set(DIRECT_AUTHORITY_ACCEPTED_AT_HEADER, String(Date.now()));
    }
    const strippedRequest = new Request(request, { headers: strippedHeaders });

    // /_w/{...source}/{className}/{objectKey}/{...method} — source-scoped
    // static DO routes. When no static namespaces exist, preserve the regular
    // worker route named `_w` by falling through to WORKER_HOST.
    const doLookup = env.WORKERD_DO_BINDINGS;
    if (prefix === "_w" && Object.keys(doLookup).length > 0) {
      if (parts.length < 5) {
        return new Response("Usage: /_w/{...source}/{className}/{objectKey}/{method}", {
          status: 400,
        });
      }
      for (let classIndex = 2; classIndex <= parts.length - 3; classIndex++) {
        const source = parts.slice(1, classIndex).map(decodeURIComponent).join("/");
        const doClass = decodeURIComponent(parts[classIndex] ?? "");
        const objectKey = decodeURIComponent(parts[classIndex + 1] ?? "");
        const doRest = parts.slice(classIndex + 2);
        if (!source || !doClass || !objectKey) continue;

        const bindingName = doLookup[`${source}:${doClass}`];
        const namespace = bindingName ? env[bindingName] : undefined;
        if (!isDurableObjectNamespace(namespace)) continue;

        const id = namespace.idFromName(objectKey);
        const stub = namespace.get(id);
        const doUrl = new URL(
          `/${encodeURIComponent(objectKey)}${doRest.length ? `/${doRest.join("/")}` : ""}`,
          url.origin
        );
        doUrl.search = url.search;
        return stub.fetch(new Request(doUrl, strippedRequest));
      }
      return new Response(`DO class not found for route: ${parts.slice(1).join("/")}`, {
        status: 404,
      });
    }

    // /_u/{encodedKey}/{...method} — userland DO via the UniversalDO facet
    // host. The encoded key packs source|className|userKey.
    if (prefix === "_u") {
      const encodedKey = parts[1] ? decodeURIComponent(parts[1]) : "";
      if (!encodedKey) {
        return new Response("Usage: /_u/{key}/{method}", { status: 400 });
      }
      const id = env.UNIVERSAL_DO.idFromName(encodedKey);
      const stub = env.UNIVERSAL_DO.get(id);
      const doRest = parts.slice(2);
      const doUrl = new URL(
        `/${encodeURIComponent(encodedKey)}${doRest.length ? `/${doRest.join("/")}` : ""}`,
        url.origin
      );
      doUrl.search = url.search;
      return stub.fetch(new Request(doUrl, strippedRequest));
    }

    // All non-DO traffic reaches the static worker host, which parses parts[0]
    // as the instance name. Authentication headers have already been removed.
    return env.WORKER_HOST.fetch(strippedRequest);
  },
};

export default router;

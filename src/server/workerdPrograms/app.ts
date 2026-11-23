/**
 * The runtime application a workspace's celld node deploys: one module, one
 * script. The router is the default export; the worker host and executable
 * preparation are named entrypoints the router reaches through service
 * bindings to its own script; UniversalDO hosts userland Durable Objects as
 * facets; product-owned Durable Object classes are added by the generated
 * entry (scripts/lib/runtime-app.mjs) through `internalDurableObjectClass`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import router from "./router.js";
import workerHost from "./workerHost.js";
import {
  classSecretName,
  DESTROY_METHOD,
  LIFECYCLE_SECRET,
  RPC_AUTH_TOKEN,
} from "./celldRuntime.js";

export { UniversalDO, ExecutablePreparation, CodeHost } from "./universalDo.js";
export default router;

export class WorkerHost extends WorkerEntrypoint<
  Parameters<NonNullable<typeof workerHost.fetch>>[1]
> {
  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(
      workerHost.fetch!(
        request as Parameters<NonNullable<typeof workerHost.fetch>>[0],
        this.env,
        this.ctx
      )
    );
  }
}

/** The internal source every product-owned class is registered under. */
const INTERNAL_DO_SOURCE = "vibestudio/internal";

type InternalEnv = Record<string, unknown> & {
  readonly INTERNAL_DO_ENV?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/**
 * The script's environment as one product class sees it. celld gives every
 * class of a script the same variables, while each product class has its own
 * identity: the host deploys the non-secret part per class in the
 * `INTERNAL_DO_ENV` variable, and this projection hands a class only its own.
 * The class's credential is a class secret (`RPC_AUTH_TOKEN__<Class>`), which
 * celld delivers to that class's env alone; it is exposed under its plain name.
 */
export function internalClassEnv(env: InternalEnv, className: string): Record<string, unknown> {
  const own = env.INTERNAL_DO_ENV?.[className];
  if (!own) throw new Error(`Runtime deployment has no environment for ${className}`);
  const token = env[classSecretName(RPC_AUTH_TOKEN, className)];
  if (typeof token !== "string")
    throw new Error(`Runtime deployment has no credential for ${className}`);
  const projected: Record<string, unknown> = { ...env, ...own, [RPC_AUTH_TOKEN]: token };
  delete projected["INTERNAL_DO_ENV"];
  delete projected[classSecretName(RPC_AUTH_TOKEN, className)];
  delete projected[classSecretName(LIFECYCLE_SECRET, className)];
  projected["WORKER_SOURCE"] = INTERNAL_DO_SOURCE;
  projected["WORKER_CLASS_NAME"] = className;
  return Object.freeze(projected);
}

type DurableObjectConstructor = new (ctx: DurableObjectState, env: never) => object;

/** Bind a product class to its per-class environment (celld audit V3). */
export function internalDurableObjectClass<T extends DurableObjectConstructor>(
  Base: T,
  className: string
): T {
  const lifecycleSecret = (env: InternalEnv): unknown =>
    env[classSecretName(LIFECYCLE_SECRET, className)];
  const Bound = class extends (Base as DurableObjectConstructor) {
    private readonly retirement: { ctx: DurableObjectState; secret: unknown };
    constructor(ctx: DurableObjectState, env: InternalEnv) {
      super(ctx, internalClassEnv(env, className) as never);
      this.retirement = { ctx, secret: lifecycleSecret(env) };
    }

    /**
     * Reclaiming the storage of a retired object is the host's lifecycle call,
     * not part of the class: it deletes everything the object stored.
     */
    async fetch(request: Request): Promise<Response> {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean);
      if (segments[1] === DESTROY_METHOD) {
        const provided = request.headers.get("X-Vibestudio-Lifecycle-Secret");
        if (typeof this.retirement.secret !== "string" || provided !== this.retirement.secret) {
          return new Response("Forbidden", { status: 403 });
        }
        await this.retirement.ctx.storage.deleteAll();
        return new Response(null, { status: 204 });
      }
      return (super["fetch" as never] as unknown as (request: Request) => Promise<Response>).call(
        this,
        request
      );
    }
  };
  Object.defineProperty(Bound, "name", { value: className });
  return Bound as unknown as T;
}

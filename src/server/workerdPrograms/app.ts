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

export { UniversalDO, ExecutablePreparation } from "./universalDo.js";
export default router;

export class WorkerHost extends WorkerEntrypoint<Parameters<typeof workerHost.fetch>[1]> {
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
 * class of a script the same env, while each product class has its own
 * identity and credentials: the host deploys them per class in the
 * `INTERNAL_DO_ENV` variable, and this projection hands a class only its own.
 */
export function internalClassEnv(env: InternalEnv, className: string): Record<string, unknown> {
  const own = env.INTERNAL_DO_ENV?.[className];
  if (!own) throw new Error(`Runtime deployment has no environment for ${className}`);
  const projected: Record<string, unknown> = { ...env, ...own };
  delete projected["INTERNAL_DO_ENV"];
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
  const Bound = class extends (Base as DurableObjectConstructor) {
    constructor(ctx: DurableObjectState, env: InternalEnv) {
      super(ctx, internalClassEnv(env, className) as never);
    }
  };
  Object.defineProperty(Bound, "name", { value: className });
  return Bound as unknown as T;
}

/**
 * Schema-derived server handlers.
 *
 * Service method tables are the wire contract. This helper makes the same
 * table the server implementation contract: every schema key must have one
 * handler, handler arguments come from the method's Zod tuple, and no extra
 * method can be implemented accidentally.
 */

import type { z } from "zod";
import { normalizeServiceArgs } from "./serviceDispatcher.js";
import { ServiceError } from "./serviceDispatcher.js";
import type { ServiceContext, ServiceHandler } from "./serviceDispatcher.js";
import type { MethodSchema, ServiceMethodSchemas } from "./typedServiceClient.js";

type Awaitable<T> = T | Promise<T>;

/** Parsed argument tuple for one method schema. */
export type ServiceHandlerArgs<D extends MethodSchema> =
  z.output<D["args"]> extends unknown[] ? z.output<D["args"]> : never;

export type ServiceMethodHandler<D extends MethodSchema> = (
  ctx: ServiceContext,
  args: ServiceHandlerArgs<D>
) => Awaitable<unknown>;

export type ServiceHandlers<M extends ServiceMethodSchemas> = {
  [K in keyof M]: ServiceMethodHandler<M[K]>;
};

/**
 * Generate one handler per schema method without restating the method table.
 *
 * The single contained assertion is justified by construction: iteration is
 * over the exact schema keys and installs exactly one wrapper for each key.
 * Callers still pass the result through `defineServiceHandler`, which checks
 * runtime key parity before accepting traffic.
 */
export function mapServiceHandlers<const M extends ServiceMethodSchemas>(
  methods: M,
  handler: <K extends keyof M>(
    method: K,
    ctx: ServiceContext,
    args: ServiceHandlerArgs<M[K]>
  ) => Awaitable<unknown>
): ServiceHandlers<M> {
  const mapped: Partial<ServiceHandlers<M>> = {};
  for (const method of Object.keys(methods) as Array<keyof M>) {
    mapped[method] = ((ctx, args) => handler(method, ctx, args)) as ServiceHandlers<M>[typeof method];
  }
  return mapped as ServiceHandlers<M>;
}

/** Parse dynamic handler arguments through the schema while preserving its
 * inferred tuple type. Direct unit-level handler calls get the same trailing
 * optional normalization as calls routed through the dispatcher. */
export function parseServiceHandlerArgs<D extends MethodSchema>(
  method: D,
  args: unknown[]
): ServiceHandlerArgs<D> {
  return method.args.parse(normalizeServiceArgs(args, method.args)) as ServiceHandlerArgs<D>;
}

/**
 * Turn an exhaustive, schema-typed handler table into the dispatcher's dynamic
 * handler shape. The sole dynamic cast is contained at this boundary, after
 * the dispatcher has validated the method name and arguments against the same
 * `methods` table.
 */
export function defineServiceHandler<const M extends ServiceMethodSchemas>(
  serviceName: string,
  methods: M,
  handlers: ServiceHandlers<M>
): ServiceHandler {
  const methodNames = new Set(Object.keys(methods));
  const handlerNames = Object.keys(handlers);
  if (
    handlerNames.length !== methodNames.size ||
    handlerNames.some((method) => !methodNames.has(method))
  ) {
    throw new Error(`Service "${serviceName}" handler table does not match its method schemas`);
  }

  return async (ctx, method, args) => {
    if (!methodNames.has(method)) {
      throw new ServiceError(
        serviceName,
        method,
        `Unknown ${serviceName} method: ${method}`,
        "ENOSYS"
      );
    }
    const methodName = method as keyof M;
    const handler = handlers[methodName];
    const parsedArgs = parseServiceHandlerArgs(methods[methodName], args);
    return await handler(ctx, parsedArgs as never);
  };
}

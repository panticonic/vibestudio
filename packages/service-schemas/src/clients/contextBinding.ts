import { CONTEXT_BOUND_METHOD_NAMES } from "./generated/runtimeClientMethods.js";

/**
 * Context binding shared by portable runtime wrappers and the authority-plan
 * compiler. A context-bound method's schema requires its input `contextId`;
 * a caller that omits it means its own bound context, exactly as the
 * runtime client it would call through supplies it. An explicit `contextId`
 * always wins.
 */
export function contextBoundMethodNames(service: string): ReadonlySet<string> {
  const names = (CONTEXT_BOUND_METHOD_NAMES as Readonly<Record<string, readonly string[]>>)[
    service
  ];
  return new Set(names ?? []);
}

/** Bind one method input object to `contextId` unless it already names one. */
export function bindContextInput(input: unknown, contextId: string): unknown {
  if (input === undefined) return { contextId };
  if (input !== null && typeof input === "object" && !Array.isArray(input))
    return { contextId, ...input };
  return input;
}

/** Bind a complete argument tuple for `service.method`; other methods pass through. */
export function bindContextArgs(
  service: string,
  method: string,
  args: readonly unknown[],
  contextId: string
): unknown[] {
  if (!contextBoundMethodNames(service).has(method)) return [...args];
  const [input, ...rest] = args;
  return [bindContextInput(input, contextId), ...rest];
}

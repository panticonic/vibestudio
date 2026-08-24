/**
 * Owns the lifetime of outbound RPC operations started inside one inbound
 * execution scope. Authority runtimes supply the current scope; the RPC core
 * reports every outbound promise through `observe`.
 *
 * This tracker is intentionally about lifetime, not error policy. Semantic
 * callers still await required effects so they can decide whether a failure is
 * handled or terminal. Draining prevents a parent authority proof from being
 * retired while any causal child is still settling.
 */
export interface CausalRpcOperationTracker<Scope extends object> {
  observe(operation: Promise<unknown>): void;
  drain(scope: Scope): Promise<void>;
}

export function createCausalRpcOperationTracker<Scope extends object>(
  currentScope: () => Scope | undefined
): CausalRpcOperationTracker<Scope> {
  const pendingByScope = new WeakMap<Scope, Set<Promise<void>>>();

  return {
    observe(operation) {
      const scope = currentScope();
      if (!scope) return;
      let pending = pendingByScope.get(scope);
      if (!pending) {
        pending = new Set();
        pendingByScope.set(scope, pending);
      }
      const settled = operation.then(
        () => undefined,
        () => undefined
      );
      pending.add(settled);
      void settled.finally(() => pending?.delete(settled));
    },

    async drain(scope) {
      const pending = pendingByScope.get(scope);
      if (!pending) return;
      // Settling one operation may synchronously begin another under the same
      // async execution scope, so keep draining until the set reaches a fixed
      // point.
      while (pending.size > 0) await Promise.all([...pending]);
      pendingByScope.delete(scope);
    },
  };
}

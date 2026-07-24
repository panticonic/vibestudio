import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Invocation-local state for Durable Objects.
 *
 * Durable Objects may interleave requests whenever a handler awaits. Caller
 * identity therefore belongs to the invocation's async context, never to
 * mutable instance fields and never to a global serialization queue.
 */
export class InvocationContext<T> {
  private readonly storage = new AsyncLocalStorage<T>();

  current(): T | undefined {
    return this.storage.getStore();
  }

  run<R>(context: T, operation: () => R): R {
    return this.storage.run(context, operation);
  }
}

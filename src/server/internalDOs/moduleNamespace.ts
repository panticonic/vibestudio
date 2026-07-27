/**
 * Publish a module's export namespace without recursively freezing the module
 * implementation.
 *
 * SES already locks the realm. Deep-hardening a CJS export crosses a different
 * boundary: it walks class prototypes and mutable implementation state. That
 * turns ordinary exported classes (for example EventEmitter) into unusable
 * constructors because their instances can no longer initialize themselves.
 *
 * The module registry needs an immutable namespace shape, not immutable class
 * instances. Keep the direct export object/function stable and let each module
 * own the lifecycle of objects it creates.
 */
export function freezeModuleNamespace<T>(value: T): T {
  if (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    Object.prototype.toString.call(value) !== "[object Module]"
  ) {
    Object.freeze(value);
  }
  return value;
}

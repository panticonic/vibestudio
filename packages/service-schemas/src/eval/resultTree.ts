/** Visit JSON record/array results without changing opaque objects or the input heap.
 * The leaf callback runs before descent so binary receipts remain atomic. Cycles
 * and repeated references retain their identity in the projected result.
 */
export async function mapEvalResultLeaves(
  value: unknown,
  project: (value: unknown) => Promise<{ value: unknown } | undefined>
): Promise<unknown> {
  const seen = new WeakMap<object, unknown>();
  async function visit(input: unknown): Promise<unknown> {
    if (typeof input !== "object" || input === null) return input;
    if (seen.has(input)) return seen.get(input);
    const leaf = await project(input);
    if (leaf) {
      seen.set(input, leaf.value);
      return leaf.value;
    }
    const prototype = Object.getPrototypeOf(input);
    const record =
      prototype === null ||
      (Object.prototype.hasOwnProperty.call(prototype, "constructor") &&
        prototype.constructor?.name === "Object");
    if (!Array.isArray(input) && !record) return input;
    const output: Record<string, unknown> | unknown[] = Array.isArray(input)
      ? new Array(input.length)
      : Object.create(prototype);
    seen.set(input, output);
    for (const key of Object.keys(input)) {
      Object.defineProperty(output, key, {
        value: await visit((input as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }
  return visit(value);
}

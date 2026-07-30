const HOST_INTRINSIC_DIRECT_METHODS = new Set(["durableWorkCapabilities"]);

/** Framework methods implemented by the durable runtime rather than a product class. */
export function isHostIntrinsicDirectMethod(method: string): boolean {
  return HOST_INTRINSIC_DIRECT_METHODS.has(method);
}

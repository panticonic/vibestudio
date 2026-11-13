/**
 * Framework methods implemented by the durable runtime or native owner base rather
 * than a product class. The host calls them on every lifecycle target, including a
 * workspace-service object whose build catalog lists only its own public methods;
 * each receiver still restricts them to the host principal.
 */
const HOST_INTRINSIC_DIRECT_METHODS = new Set([
  "durableWorkCapabilities",
  "prepareDurableWorkRelease",
  "waitDurableWorkRelease",
  "inspectNativeInvocationSource",
  "onAuthorityChanged",
]);

export function isHostIntrinsicDirectMethod(method: string): boolean {
  return HOST_INTRINSIC_DIRECT_METHODS.has(method);
}

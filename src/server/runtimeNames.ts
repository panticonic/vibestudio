/** Names the host and the deployed runtime application agree on. */

/** The one deployed script of a workspace's node. */
export const RUNTIME_SCRIPT = "vibestudio";

/** Class secrets (celld docs/fork/class-secrets.md): a name is unique per
 * script, so a class's secret binding carries the class name. */
export const RPC_AUTH_TOKEN = "RPC_AUTH_TOKEN";
export const UNIVERSAL_DO_LOADER_SECRET = "DO_LOADER_SECRET";
/** Authorizes the host to delete a product object's storage (retirement). */
export const LIFECYCLE_SECRET = "LIFECYCLE_SECRET";
/** The path segment a class answers a storage-destroy request on. */
export const DESTROY_METHOD = "__vibestudio_destroy";

export function classSecretName(name: string, className: string): string {
  return `${name}__${className}`;
}

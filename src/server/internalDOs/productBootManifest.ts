import { readHostBuildFingerprint, resolveRequiredHostArtifactRoot } from "../appRoot.js";

/**
 * Stable identity of the installed Vibestudio host. Userland runtime labels
 * never manufacture this principal: only `createHostCaller` can attest that a
 * call originated inside the product host.
 */
export interface ProductBootManifest {
  version: 1;
  hostPrincipal: `host:${string}`;
}

let cached: ProductBootManifest | undefined;

export function getProductBootManifest(): ProductBootManifest {
  if (cached) return cached;
  const fingerprint = readHostBuildFingerprint(resolveRequiredHostArtifactRoot()).fingerprint;
  cached = Object.freeze({
    version: 1,
    hostPrincipal: `host:${fingerprint}`,
  });
  return cached;
}

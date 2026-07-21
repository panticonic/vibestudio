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
  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  const fingerprintPath = path.join(appRoot, "dist", "host-build-fingerprint.json");
  let fingerprint: unknown;
  try {
    fingerprint = (JSON.parse(fs.readFileSync(fingerprintPath, "utf8")) as Record<string, unknown>)[
      "fingerprint"
    ];
  } catch (error) {
    throw new Error(
      `Installed host build identity is unavailable at ${fingerprintPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`Installed host build identity is malformed at ${fingerprintPath}`);
  }
  cached = Object.freeze({
    version: 1,
    hostPrincipal: `host:${fingerprint}`,
  });
  return cached;
}
import * as fs from "node:fs";
import * as path from "node:path";

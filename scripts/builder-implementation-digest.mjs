import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILDER_IMPLEMENTATION_CONTRACT = "vibestudio-build-v2/execution-recipe/v1";

function updateFrame(hash, value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

/**
 * Hash the exact recipe and builder implementations with the same framed
 * domain used by runtime execution identity. Full builds inject this value
 * into bundled hosts; source servers compute it from their checkout.
 */
export function computeBuilderImplementationDigest(repositoryRoot) {
  const recipePath = path.join(repositoryRoot, "src/server/buildV2/executionRecipe.ts");
  const builderPath = path.join(repositoryRoot, "src/server/buildV2/builder.ts");
  const hash = createHash("sha256");
  updateFrame(hash, "vibestudio/builder-implementation/v1");
  updateFrame(hash, BUILDER_IMPLEMENTATION_CONTRACT);
  updateFrame(hash, fs.readFileSync(recipePath));
  updateFrame(hash, fs.readFileSync(builderPath));
  return hash.digest("hex");
}

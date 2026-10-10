import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRequiredHostArtifactRoot } from "./appRoot.js";

/** Helper workers always belong to the server's explicit compiled generation. */
export function resolveHostWorkerEntry(filename: string): string {
  const entry = path.join(resolveRequiredHostArtifactRoot(), filename);
  if (!fs.existsSync(entry)) throw new Error(`Host worker artifact is missing at ${entry}`);
  return entry;
}

import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";

const dependencyCaches = {
  "external-deps": /^[a-f0-9]{16}$/u,
  "extension-runtime-deps":
    /^[a-f0-9]{16}-(?:linux|darwin|win32)-(?:x64|arm64)-node\d+\.\d+\.\d+$/u,
};

export function dependencyCacheRoot(kind: keyof typeof dependencyCaches): string {
  return path.join(getSharedDerivedDataPath(), kind);
}

/** Maintenance consumes the same cache coordinates as dependency publication. */
export function dependencyCacheLocation(value: string): {
  root: string;
  key: string;
  directory: string;
} {
  const directory = path.resolve(value);
  const root = path.dirname(directory);
  const key = path.basename(directory);
  for (const [kind, keyPattern] of Object.entries(dependencyCaches)) {
    if (
      root === dependencyCacheRoot(kind as keyof typeof dependencyCaches) &&
      keyPattern.test(key)
    ) {
      return { root, key, directory };
    }
  }
  throw new Error(`Refusing invalid dependency cache directory: ${directory}`);
}

import * as path from "node:path";
import { API } from "typescript/unstable/sync";
import { configureNativeCompilerMemory } from "@vibestudio/shared/compilerResourcePolicy";

export function configuredCompilerOptions(config: string) {
  configureNativeCompilerMemory();
  const api = new API({ cwd: path.dirname(config) });
  try {
    return api.parseConfigFile(config).options;
  } finally {
    api.close();
  }
}

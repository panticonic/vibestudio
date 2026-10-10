import * as path from "node:path";
import { API } from "typescript/unstable/sync";

export function configuredCompilerOptions(config: string) {
  const api = new API({ cwd: path.dirname(config) });
  try {
    return api.parseConfigFile(config).options;
  } finally {
    api.close();
  }
}

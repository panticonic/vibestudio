import * as path from "node:path";
import { API } from "typescript/unstable/sync";

export function configuredFiles(config: string): string[] {
  const api = new API({ cwd: path.dirname(config) });
  try {
    return api.parseConfigFile(config).fileNames;
  } finally {
    api.close();
  }
}

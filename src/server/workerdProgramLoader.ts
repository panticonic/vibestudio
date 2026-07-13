import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkerdProgramSources {
  readonly router: string;
  readonly workerHost: string;
  readonly universalDo: string;
}

declare const globalThis: { __VIBESTUDIO_WORKERD_PROGRAMS__?: WorkerdProgramSources };

let cached: WorkerdProgramSources | null = null;

export function getWorkerdProgramSources(): WorkerdProgramSources {
  if (cached) return cached;

  const inlined = globalThis.__VIBESTUDIO_WORKERD_PROGRAMS__;
  if (isCompleteProgramSet(inlined)) {
    cached = inlined;
    return cached;
  }

  const runtimeDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  const candidates = [
    path.join(runtimeDir, "workerd-programs"),
    path.resolve(appRoot, "dist/workerd-programs"),
  ];
  for (const directory of candidates) {
    const loaded = readPrograms(directory);
    if (!loaded) continue;
    cached = loaded;
    return cached;
  }

  throw new Error(
    `Compiled workerd programs are unavailable. Run \`pnpm build\` (or the source-server prerequisites) so ${candidates.join(" or ")} exists.`
  );
}

function isCompleteProgramSet(
  value: WorkerdProgramSources | undefined
): value is WorkerdProgramSources {
  return (
    typeof value?.router === "string" &&
    value.router.length > 0 &&
    typeof value.workerHost === "string" &&
    value.workerHost.length > 0 &&
    typeof value.universalDo === "string" &&
    value.universalDo.length > 0
  );
}

function readPrograms(directory: string): WorkerdProgramSources | null {
  const files = {
    router: path.join(directory, "router.mjs"),
    workerHost: path.join(directory, "worker-host.mjs"),
    universalDo: path.join(directory, "universal-do.mjs"),
  };
  if (Object.values(files).some((file) => !fs.existsSync(file))) return null;
  return {
    router: fs.readFileSync(files.router, "utf8"),
    workerHost: fs.readFileSync(files.workerHost, "utf8"),
    universalDo: fs.readFileSync(files.universalDo, "utf8"),
  };
}

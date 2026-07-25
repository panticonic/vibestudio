export const NPM_UPDATE_CONTRACT_VERSION: 1;
export const NPM_UPDATE_REQUESTED_EXIT_CODE: 86;
export const NPM_DESKTOP_PACKAGE_NAME: "@panticonic/vibestudio";
export const NPM_UPDATE_ENV: Readonly<{
  launch: "VIBESTUDIO_NPM_UPDATE_LAUNCH";
  resultPath: "VIBESTUDIO_NPM_UPDATE_RESULT";
}>;
export const NPM_UPDATE_FILES: Readonly<{
  request: "request.json";
  result: "result.json";
  log: "update.log";
  lock: "npm-update.lock";
  provenanceCache: "npm-update-provenance.json";
}>;

export interface UpdateLaunch {
  contractVersion: 1;
  packageName: "@panticonic/vibestudio";
  packageRoot: string;
  globalRoot: string;
  globalPrefix: string;
  npmExecutable: string;
  currentVersion: string;
  canInstall: boolean;
  requestDirectory?: string;
  nonce?: string;
}

export interface UpdateRequest {
  contractVersion: 1;
  action: "install-update";
  packageName: "@panticonic/vibestudio";
  nonce: string;
  fromVersion: string;
  toVersion: string;
  requestedAt: string;
}

export interface UpdateResult {
  contractVersion: 1;
  packageName: "@panticonic/vibestudio";
  fromVersion: string;
  toVersion: string;
  outcome: "succeeded" | "restored" | "failed";
  npmExitStatus: number | null;
  summary: string;
  logPath: string;
  completedAt: string;
  installedVersion: string | null;
}

export function isExactSemver(value: unknown): value is string;
export function validateUpdateLaunch(value: unknown): UpdateLaunch | null;
export function validateUpdateRequest(value: unknown): UpdateRequest | null;
export function validateUpdateResult(value: unknown): UpdateResult | null;
export function readPrivateJson<T>(
  filePath: string,
  validator: (value: unknown) => T | null
): T | null;
export function writePrivateJsonAtomic(filePath: string, value: unknown): void;
export function parseUpdateLaunchEnvironment(env?: NodeJS.ProcessEnv): UpdateLaunch | null;
export function isPrivateUpdateFile(
  filePath: unknown,
  expectedBasename: string
): filePath is string;

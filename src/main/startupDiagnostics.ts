import * as path from "node:path";

export interface StartupErrorPaths {
  directory: string;
  reportPath: string;
  serverLogPath?: string;
}

export interface StartupErrorReport {
  failedAt: string;
  message: string;
  detail: string;
  logPath?: string;
}

export interface StartupPathDiagnostics {
  platform: string;
  arch: string;
  cwd: string;
  execPath: string;
  appPath: string;
  userDataPath: string;
  nodeEnv: string | undefined;
  isDevelopment: boolean;
  appRoot: string;
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Resolve startup-report locations without consulting Electron or process globals. */
export function resolveStartupErrorPaths(
  userDataDirectory: string,
  workspaceDirectory?: string
): StartupErrorPaths {
  const directory = workspaceDirectory ? path.join(workspaceDirectory, "state") : userDataDirectory;
  return {
    directory,
    reportPath: path.join(directory, "startup-error.json"),
    ...(workspaceDirectory ? { serverLogPath: path.join(directory, "logs", "server.log") } : {}),
  };
}

export function createStartupErrorReport(
  error: unknown,
  paths: StartupErrorPaths,
  failedAt: Date
): StartupErrorReport {
  return {
    failedAt: failedAt.toISOString(),
    message: error instanceof Error ? error.message : String(error),
    detail: formatUnknownError(error),
    ...(paths.serverLogPath ? { logPath: paths.serverLogPath } : {}),
  };
}

/** Ordered entries preserve the existing human-readable startup log format. */
export function startupPathDiagnosticEntries(
  diagnostics: StartupPathDiagnostics
): ReadonlyArray<readonly [label: string, value: string | boolean | undefined]> {
  return [
    ["[diagnostics] process.platform:", diagnostics.platform],
    ["[diagnostics] process.arch:", diagnostics.arch],
    ["[diagnostics] process.cwd():", diagnostics.cwd],
    ["[diagnostics] process.execPath:", diagnostics.execPath],
    ["[diagnostics] app.getAppPath():", diagnostics.appPath],
    ["[diagnostics] app.getPath('userData'):", diagnostics.userDataPath],
    ["[diagnostics] NODE_ENV:", diagnostics.nodeEnv],
    ["[diagnostics] isDev():", diagnostics.isDevelopment],
    ["[diagnostics] getAppRoot():", diagnostics.appRoot],
  ];
}

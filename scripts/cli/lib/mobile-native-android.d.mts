export interface AndroidDevice {
  serial: string;
  state: "device" | "unauthorized" | "offline";
  model?: string;
}
export interface NativeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore" | "inherit";
  errorCode?: string;
  reject?: boolean;
}
export function androidDir(appRoot: string): string;
export function internalAndroidApkPath(appRoot: string): string;
export function hasCompleteAndroidSourceProject(appRoot: string): boolean;
export function mobileCliEnvironment(
  appRoot: string,
  appVersion?: string,
  env?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
export function validateAndroidArchitectures(value?: string[]): string[];
export function adbArgs(device: string | undefined, args: string[]): string[];
export function runNativeCommand(
  command: string,
  args: string[],
  options?: NativeCommandOptions
): Promise<void>;
export function runNativeCapture(
  command: string,
  args: string[],
  options?: NativeCommandOptions
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: string }>;
export function parseAdbDevices(raw: string): AndroidDevice[];
export function listAdbDevices(options?: {
  adbPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AndroidDevice[]>;
export function pickAndroidDevice(devices: AndroidDevice[], requested?: string): AndroidDevice;
export function readAndroidDeviceAbi(options: {
  device: string;
  adbPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string>;
export function buildAndroidApp(options: {
  appRoot: string;
  variant?: "internal" | "release";
  device?: string;
  architectures?: string[];
  rerunTasks?: boolean;
  adbPath?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore" | "inherit";
}): Promise<{ apkPath: string; apkBytes: number; architectures: string[]; durationMs: number }>;
export const INTERNAL_ANDROID_PACKAGE: string;
export const SUPPORTED_ANDROID_ABIS: readonly string[];

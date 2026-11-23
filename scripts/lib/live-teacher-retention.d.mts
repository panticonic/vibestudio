export const nativeStorageRetentionEnvironmentKey: "VIBESTUDIO_RETAIN_NATIVE_STORAGE";
export function liveTeacherEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function moveRetainedState(input: {
  retained: string;
  destination: string;
  instance: string;
  stopped: boolean;
}): void;

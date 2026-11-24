export const nativeStorageRetentionEnvironmentKey: "VIBESTUDIO_RETAIN_NATIVE_STORAGE";
export function liveTeacherEnvironment(environment?: Record<string, string | undefined>): Record<string, string | undefined> & { VIBESTUDIO_RETAIN_NATIVE_STORAGE: "0" | "1" };
export function moveRetainedState(input: {retained:string;destination:string;instance:string;stopped:boolean}): void;

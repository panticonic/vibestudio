export interface PublishedRuntimeApp {
  readonly format: "vibestudio-runtime-app/1";
  readonly bundle: string;
  readonly buildKey: string;
  readonly internalClasses: readonly string[];
}
export interface CompiledRuntimeApp {
  readonly bundle: string;
  readonly exports: readonly string[];
}
export const RUNTIME_APP_FILE: string;
export const RUNTIME_APP_FORMAT: "vibestudio-runtime-app/1";
export const RUNTIME_APP_HOST_EXPORTS: readonly string[];
export const INTERNAL_DO_PROGRAM_ENTRIES: readonly {
  readonly className: string;
  readonly implementation: string;
}[];
export function readPublishedRuntimeApp(input: unknown): PublishedRuntimeApp;
export function assertRuntimeAppPublication(input: unknown): PublishedRuntimeApp;
export function captureRuntimeApp(compiled: CompiledRuntimeApp): PublishedRuntimeApp;
export function runtimeAppEntrypointSource(): string;

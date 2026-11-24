export const DEFAULT_NATIVE_COMPILER_MEMORY_LIMIT: "2GiB";
export function configureNativeCompilerMemory(
  environment?: Record<string, string | undefined>
): Record<string, string | undefined>;
export function configuredCompilerConcurrency(configured: string | undefined): number | undefined;

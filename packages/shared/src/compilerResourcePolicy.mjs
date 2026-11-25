/** Node's heap setting does not govern TypeScript 7's native Go child. */
export const DEFAULT_NATIVE_COMPILER_MEMORY_LIMIT = "2GiB";

/** Install the process's default native compiler collection policy before spawn.
 * An explicit standard Go setting, including `off`, belongs to the caller.
 * This is a soft GC target, not an admission budget or a compiler input limit.
 */
export function configureNativeCompilerMemory(environment = process.env) {
  if (environment.GOMEMLIMIT === undefined)
    environment.GOMEMLIMIT = DEFAULT_NATIVE_COMPILER_MEMORY_LIMIT;
  return environment;
}

/** One declared compiler budget must mean the same thing at every launcher. */
export function configuredCompilerConcurrency(configured) {
  if (configured === undefined || configured.trim() === "") return undefined;
  const value = configured.trim();
  const count = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(count))
    throw new TypeError("VIBESTUDIO_MAX_CONCURRENT_BUILDS must be a positive safe integer");
  return count;
}

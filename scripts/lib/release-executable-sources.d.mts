export const EXECUTABLE_MODULES_FILE: "executable-modules.json.gz";
export const EXECUTABLE_MODULE_REFS_FILE: "executable-module-refs.json.gz";
export const EXECUTABLE_SOURCES_DIR: "executable-sources";

/** One inventory entry without its source. */
export interface ExecutableModuleReference {
  moduleId: string;
  contentDigest: string;
  package: unknown;
  format: string;
}
export type ExecutableModuleEntry = ExecutableModuleReference & { source: string };

export function executableSourceFile(poolDirectory: string, digest: string): string;
export function executableSourceDigest(source: string): string;
export function compactExecutableModules(modules: readonly ExecutableModuleEntry[]): {
  references: ExecutableModuleReference[];
  sources: Map<string, string>;
};
export function writeExecutableSources(
  poolDirectory: string,
  sources: ReadonlyMap<string, string>
): Promise<void>;
export function readExecutableSource(poolDirectory: string, digest: string): Promise<string>;
export function expandExecutableModules(
  references: readonly ExecutableModuleReference[],
  poolDirectory: string
): Promise<ExecutableModuleEntry[]>;
export function parseExecutableModulesFile(bytes: Buffer): Array<Record<string, unknown>>;
export function encodeExecutableModuleReferences(
  references: readonly ExecutableModuleReference[]
): Buffer;
export function verifyExecutableSourcePool(
  poolDirectory: string,
  referencedDigests: Iterable<string>
): Promise<void>;

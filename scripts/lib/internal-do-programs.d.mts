export interface PublishedInternalDoPrograms {
  readonly format: "vibestudio-internal-do-programs/1";
  readonly programs: Readonly<
    Record<string, { readonly bundle: string; readonly buildKey: string }>
  >;
}
export interface CompiledInternalDoProgram {
  readonly bundle: string;
  readonly exports: readonly string[];
}
export const INTERNAL_DO_PROGRAMS_FILE: string;
export const INTERNAL_DO_PROGRAM_ENTRIES: readonly {
  readonly className: string;
  readonly implementation: string;
}[];
export function readPublishedInternalDoPrograms(input: unknown): PublishedInternalDoPrograms;
export function assertInternalDoProgramsPublication(input: unknown): PublishedInternalDoPrograms;
export function captureInternalDoPrograms(
  compiled: Readonly<Record<string, CompiledInternalDoProgram>>
): PublishedInternalDoPrograms;
export function internalDoEntrypointSource(className: string): string;

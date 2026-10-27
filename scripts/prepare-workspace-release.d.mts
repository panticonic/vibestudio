import type { Ownership } from "@vibestudio/shared/ownership";
export type WorkspacePreparationProgress =
  | { phase: "sources"; done: number; total: number; item: string }
  | { phase: "runtimes"; done: number; total: number | null; item: string };
export interface WorkspaceReleasePreparation {
  sourcesReady: Promise<void>;
  completed: Promise<void>;
  stop(): Promise<void>;
}
export function isCancellationOnly(error: unknown, active?: Set<object>): boolean;
export function prepareWorkspaceRelease(input: {
  /** The owner of the producer: its group is retired with this ownership. */
  ownership: Ownership;
  appRoot: string;
  output: string;
  sourceOutput?: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  entry: string;
  /** "sources" publishes only template sources; "existing" only consumes a completed release; the default builds the complete release. */
  scope?: "sources" | "release" | "existing";
  /**
   * Receives the producer's own progress as it happens: template sources
   * prepared (`done` of `total`), then runtimes built.
   */
  onProgress?: (progress: WorkspacePreparationProgress) => void;
  /** Receives the producer's stdout and stderr instead of this process's streams. */
  log?: NodeJS.WritableStream;
}): WorkspaceReleasePreparation;

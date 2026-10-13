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
  appRoot: string;
  output: string;
  sourceOutput?: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  entry: string;
  /** "sources" publishes only template sources; the default is the complete release. */
  scope?: "sources" | "release";
  /**
   * Receives the producer's own progress as it happens: template sources
   * prepared (`done` of `total`), then runtimes built.
   */
  onProgress?: (progress: WorkspacePreparationProgress) => void;
  /** Receives the producer's stdout and stderr instead of this process's streams. */
  log?: NodeJS.WritableStream;
}): WorkspaceReleasePreparation;

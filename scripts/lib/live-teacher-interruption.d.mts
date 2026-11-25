import type { ChildProcess, SpawnOptions } from "node:child_process";
export function forwardCommandInterruption(signal: AbortSignal, child: ChildProcess): () => void;
export function runTeacherCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  signal?: AbortSignal
): Promise<{ status: number; signal: NodeJS.Signals | null; stdout: string }>;
export function collectionInterruption(input: {
  requestPath?: string;
  out: string;
  cases: string[];
  processSignals?: NodeJS.Process;
}): { signal: AbortSignal; complete(names: string[]): void; defer(name: string, reason: string): void; dispose(): void };

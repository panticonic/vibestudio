export function signalExitCode(signal: NodeJS.Signals): number;
interface RunnerChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): unknown;
}
export function createRunnerShutdown(options: {
  activeChildren: ReadonlySet<RunnerChild>;
  exit(code: number): void;
  requestGracefulStop?: (child: RunnerChild, signal: NodeJS.Signals) => void;
}): {
  request(signal: NodeJS.Signals): void;
  childExited(): void;
  requestedSignal(): NodeJS.Signals | null;
};

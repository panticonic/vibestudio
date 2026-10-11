export function closeOwnedDesktop(
  app: {
    close(): Promise<void>;
    process(): { exitCode: number | null; signalCode: string | null };
  },
  owner: { join(): Promise<void>; retire(signal: "SIGKILL"): Promise<void> }
): Promise<void>;

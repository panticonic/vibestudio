export function closeOwnedDesktop(
  app: {
    close(): Promise<void>;
    process(): { exitCode: number | null; signalCode: string | null };
  },
  owner?: { join(): Promise<void>; retire(mode: "immediate"): Promise<void> }
): Promise<void>;

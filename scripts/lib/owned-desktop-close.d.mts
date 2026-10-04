export function closeOwnedDesktop(
  app: { close(): Promise<void> },
  owner: { join(): Promise<void>; retire(signal: "SIGKILL"): Promise<void> }
): Promise<void>;

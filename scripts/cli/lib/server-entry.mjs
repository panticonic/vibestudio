export function serverEntryArg() {
  return process.env.VIBESTUDIO_SERVER_ENTRY === "live" ? "src/server/index.ts" : "dist/server.mjs";
}

export function createServerInvocation(serverArgs) {
  if (serverArgs[0] === "src/server/index.ts") {
    // Execute the TypeScript entry in this process rather than adding pnpm,
    // a shell, and the tsx CLI as signal-forwarding ancestors. The spawned
    // process is then the actual hub and can own graceful child shutdown.
    return {
      command: process.execPath,
      args: ["--import", "tsx", ...serverArgs],
    };
  }
  return {
    command: process.execPath,
    args: serverArgs,
  };
}

export function serverEntryArg() {
  return process.env.NATSTACK_SERVER_ENTRY === "live" ? "src/server/index.ts" : "dist/server.mjs";
}

export function serverEntryDescription() {
  return process.env.NATSTACK_SERVER_ENTRY === "live" ? "src/server/index.ts" : "dist/server.mjs";
}

export function createServerInvocation(serverArgs) {
  if (serverArgs[0] === "src/server/index.ts") {
    return {
      command: "pnpm",
      args: ["exec", "tsx", ...serverArgs],
    };
  }
  return {
    command: process.execPath,
    args: serverArgs,
  };
}

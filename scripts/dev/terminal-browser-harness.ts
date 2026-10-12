/**
 * TEST-ONLY development harness for the terminal browser.
 *
 * Runs the server-built `apps/terminal-browser` artifact in this process
 * against a running developer instance, through the same
 * `TerminalBrowserHost` contract the `vibestudio terminal` CLI provides. It
 * connects with the instance's paired CLI device credential (a shell
 * principal) because the app-principal grant belongs to the CLI launch path;
 * once `pnpm terminal` exists this harness is redundant and should be deleted.
 *
 *   node --import tsx scripts/dev/terminal-browser-harness.ts --instance term-browser-1
 *
 * Exits with the browser's exit kind printed to stderr.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { createRpcClient } from "@vibestudio/rpc";
import { NodeWsLike } from "@vibestudio/rpc/transports/nodeWsLike";
import { createServerWsTransport } from "@vibestudio/shell-core/transport/serverWsTransport";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import type {
  TerminalBrowserHost,
  TerminalBrowserModule,
  TerminalServerConnectionState,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import { resolveDevInstance, waitForDevInstanceReady } from "../../src/dev/instanceRegistry.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<number> {
  const instanceId = argument("--instance");
  if (!instanceId) throw new Error("usage: terminal-browser-harness --instance ID");
  const repoRoot = process.cwd();
  const instance = resolveDevInstance(repoRoot, instanceId);
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = instance.root;
  process.env["VIBESTUDIO_INSTANCE"] = instance.id;
  const ready = await waitForDevInstanceReady(instance);
  const { loadCliCredentials } = await import("../../src/cli/credentialStore.js");
  const { shellCallerId } = await import("../../src/cli/rpcClient.js");
  const creds = loadCliCredentials();
  if (!creds || creds.kind !== "device")
    throw new Error(`instance ${instanceId} has no paired CLI device`);

  const selfId = shellCallerId(creds.deviceId);
  const connectionId = randomUUID();
  const transport = createServerWsTransport({
    selfId,
    serverUrl: creds.url,
    connectionId,
    logPrefix: "TerminalBrowserHarness",
    getAuthMessageFields: () => ({
      connectionId,
      clientLabel: "Vibestudio Terminal (dev harness)",
      clientPlatform: "headless",
      oauthCallbackMode: "client-loopback",
    }),
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => `refresh:${creds.deviceId}:${creds.refreshToken}`,
      createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
    },
  });
  const rpc = createRpcClient({ selfId, callerKind: "shell", transport });
  await transport.connectAndWait();

  // Build the browser exactly as the server builds it for the CLI.
  const build = (await rpc.call("main", mainRpcMethods["build.getBuild"], [
    "apps/terminal-browser",
  ])) as { artifacts: Array<{ path: string; role: string; content: string }> };
  const primary = build.artifacts.find((artifact) => artifact.role === "primary");
  if (!primary) throw new Error("terminal-browser build has no primary artifact");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-terminal-browser-"));
  const file = path.join(dir, primary.path);
  fs.writeFileSync(file, primary.content);
  const browser = (await import(pathToFileURL(file).href)) as TerminalBrowserModule;

  const info = (await rpc.call("main", mainRpcMethods["workspace.getInfo"], [])) as {
    config?: { id?: string };
  };
  let state: TerminalServerConnectionState = { phase: "connected" };
  const listeners = new Set<(next: TerminalServerConnectionState) => void>();
  transport.onStatusChange?.((status) => {
    state =
      status === "connected" ? { phase: "connected" } : { phase: "reconnecting", cause: status };
    for (const listener of [...listeners]) listener(state);
  });
  const host: TerminalBrowserHost = {
    contractVersion: 1,
    rpc,
    appId: selfId,
    workspace: { id: info.config?.id ?? "workspace", name: ready.workspaceName ?? instance.id },
    server: { kind: "attached", endpoint: creds.url },
    stdin: process.stdin,
    stdout: process.stdout,
    connectionState: () => state,
    onConnectionState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listWorkspaces: async () => [
      { id: info.config?.id ?? "workspace", name: ready.workspaceName ?? instance.id },
    ],
    openExternal: async (url) => {
      fs.appendFileSync(path.join(dir, "opened-urls.txt"), `${url}\n`);
    },
    readLocalFile: async (filePath) => ({
      name: path.basename(filePath),
      bytes: new Uint8Array(fs.readFileSync(filePath)),
    }),
  };
  try {
    const exit = await browser.run(host);
    process.stderr.write(`terminal browser exited: ${JSON.stringify(exit)}\n`);
    return 0;
  } finally {
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  }
);

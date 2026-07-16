import React from "react";
import { render } from "ink";
import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import { NodeWsLike } from "@vibestudio/shell-core/transport/nodeWsLike";
import { createServerWsTransport } from "@vibestudio/shell-core/transport/serverWsTransport";
import WebSocket from "ws";
import { SessionManager } from "./host/SessionManager.js";
import { registerHostService } from "./host/HostService.js";
import { createApprovalsClient } from "./approvals/approvalsClient.js";
import { TerminalBrowser } from "./host/TerminalBrowser.js";
import type { LogLine } from "./ui/LogsView.js";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Minimal append-only log sink shared by the runner events + the LogsView. */
interface LogSink {
  lines: LogLine[];
  push(line: LogLine): void;
  subscribe(listener: () => void): () => void;
}
function createLogSink(): LogSink {
  const lines: LogLine[] = [];
  const listeners = new Set<() => void>();
  return {
    lines,
    push(line) {
      lines.push(line);
      if (lines.length > 500) lines.splice(0, lines.length - 500);
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function connect(appId: string, logSink: LogSink) {
  const token = requiredEnv("VIBESTUDIO_TERMINAL_APP_RPC_TOKEN");
  const connectionId = requiredEnv("VIBESTUDIO_TERMINAL_APP_CONNECTION_ID");
  const transport = createServerWsTransport({
    selfId: appId,
    serverUrl: requiredEnv("VIBESTUDIO_TERMINAL_APP_GATEWAY_URL"),
    connectionId,
    logPrefix: "TerminalBrowser",
    getAuthMessageFields: () => ({
      connectionId,
      clientLabel: "Vibestudio Terminal",
      clientPlatform: "desktop",
    }),
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => token,
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });
  const rpc: RpcClient = createRpcClient({
    selfId: appId,
    callerKind: "app",
    transport,
  });

  transport.onStatusChange?.((status) => {
    if (status === "disconnected") process.exit(0);
  });
  await transport.connectAndWait();
  const events = new EventsClient(rpc);
  for (const event of ["apps:lifecycle", "apps:status"] as const) {
    events.on(event, (payload) => {
      logSink.push({ level: "info", source: event, message: JSON.stringify(payload) });
    });
  }
  await events.subscribeAll(["apps:lifecycle", "apps:status"]);
  return { rpc, close: () => transport.close() };
}

export async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // The interactive host needs a real terminal. The supervised terminal-app
    // runner pipes stdio (for headless CLIs), so the browser must be launched
    // attached to an interactive TTY — see docs/terminal-apps.md.
    console.error(
      "terminal-browser must run attached to an interactive TTY " +
        "(stdin/stdout are not TTYs in this environment)."
    );
    process.exit(1);
  }

  const appId = requiredEnv("VIBESTUDIO_TERMINAL_APP_ID");
  const logSink = createLogSink();
  const { rpc, close } = await connect(appId, logSink);
  const workspaceClient = createTypedServiceClient(
    "workspace",
    workspaceMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );

  const workspace = (await workspaceClient.getInfo().catch(() => null)) as {
    config?: { id?: string };
  } | null;
  const workspaceId = workspace?.config?.id ?? "default";

  const sessions = new SessionManager({
    rpc,
    hostPrincipalId: appId,
    viewport: {
      columns: process.stdout.columns ?? 80,
      rows: Math.max(1, (process.stdout.rows ?? 24) - 2), // reserve header + footer
    },
  });

  const hostState = { overlayOpen: false };
  registerHostService(rpc, {
    sessions,
    // Host keeps the real TTY in raw mode while running; only allow enabling.
    setRealRawMode: (enabled) => {
      if (enabled) process.stdin.setRawMode?.(true);
    },
    isOverlayOpen: () => hostState.overlayOpen,
  });

  const approvals = createApprovalsClient(rpc);
  const HostRoot: React.FC = () => {
    const [, force] = React.useState(0);
    React.useEffect(() => logSink.subscribe(() => force((n) => n + 1)), []);
    return React.createElement(TerminalBrowser, {
      sessions,
      approvals,
      workspaceId,
      logs: logSink.lines,
      hostState,
    });
  };

  const instance = render(React.createElement(HostRoot), { exitOnCtrlC: false });

  process.stdout.on("resize", () => {
    void sessions.resize({
      columns: process.stdout.columns ?? 80,
      rows: Math.max(1, (process.stdout.rows ?? 24) - 2),
    });
  });

  process.on("message", (message) => {
    if ((message as { type?: string })?.type === "shutdown") {
      void sessions.closeAll("host shutdown").finally(() => {
        instance.unmount();
        close();
      });
    }
  });

  await instance.waitUntilExit();
  await sessions.closeAll("host exit");
  close();
}

if (process.env["VIBESTUDIO_TERMINAL_APP_GATEWAY_URL"]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

import React from "react";
import { render } from "ink";
import { createRpcBridge, createHandlerRegistry, type RpcMessage, type RpcBridge } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import WebSocket from "ws";
import { SessionManager } from "./host/SessionManager.js";
import { registerHostService } from "./host/HostService.js";
import { createApprovalsClient } from "./approvals/approvalsClient.js";
import { TerminalBrowser } from "./host/TerminalBrowser.js";
import type { LogLine } from "./ui/LogsView.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function gatewayWebSocketUrl(): string {
  const url = new URL(requiredEnv("NATSTACK_TERMINAL_APP_GATEWAY_URL"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.endsWith("/rpc") ? url.pathname : "/rpc";
  url.search = "";
  url.hash = "";
  return url.toString();
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
  const token = requiredEnv("NATSTACK_TERMINAL_APP_RPC_TOKEN");
  const connectionId = requiredEnv("NATSTACK_TERMINAL_APP_CONNECTION_ID");
  const ws = new WebSocket(gatewayWebSocketUrl());
  const registry = createHandlerRegistry({ context: appId });
  const bridge = createRpcBridge({
    selfId: appId,
    transport: {
      async send(_targetId: string, message: RpcMessage): Promise<void> {
        if (ws.readyState !== WebSocket.OPEN) throw new Error("terminal-browser RPC not connected");
        ws.send(JSON.stringify({ type: "ws:rpc", message } satisfies WsClientMessage));
      },
      onMessage: (sourceId, handler) => registry.onMessage(sourceId, handler),
      onAnyMessage: (handler) => registry.onAnyMessage(handler),
    },
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal-browser auth timeout")), 10_000);
    const fail = (e: unknown) => {
      clearTimeout(timeout);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "ws:auth",
          token,
          connectionId,
          clientLabel: "NatStack Terminal",
          clientPlatform: "desktop",
        } satisfies WsClientMessage),
      );
    });
    ws.on("message", function onAuth(data) {
      const message = JSON.parse(String(data)) as WsServerMessage;
      if (message.type !== "ws:auth-result") return;
      ws.off("message", onAuth);
      ws.off("error", fail);
      clearTimeout(timeout);
      if (!message.success) reject(new Error(`auth failed: ${message.error ?? "unknown"}`));
      else resolve();
    });
  });

  ws.on("message", (data) => {
    let message: WsServerMessage;
    try {
      message = JSON.parse(String(data)) as WsServerMessage;
    } catch {
      return;
    }
    if (message.type === "ws:rpc") registry.deliver("main", message.message, "server");
    else if (message.type === "ws:routed")
      registry.deliver(message.fromId, message.message, message.fromKind);
    else if (message.type === "ws:event") {
      if (message.event === "apps:lifecycle" || message.event === "apps:status") {
        logSink.push({ level: "info", source: message.event, message: JSON.stringify(message.payload) });
      }
    }
  });
  ws.on("close", () => process.exit(0));
  return { bridge, close: () => ws.close(1000, "terminal-browser closing") };
}

export async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // The interactive host needs a real terminal. The supervised terminal-app
    // runner pipes stdio (for headless CLIs), so the browser must be launched
    // attached to an interactive TTY — see docs/terminal-apps.md.
    console.error(
      "terminal-browser must run attached to an interactive TTY " +
        "(stdin/stdout are not TTYs in this environment).",
    );
    process.exit(1);
  }

  const appId = requiredEnv("NATSTACK_TERMINAL_APP_ID");
  const logSink = createLogSink();
  const { bridge, close } = await connect(appId, logSink);

  const workspace = (await bridge.call("main", "workspace.getInfo", []).catch(() => null)) as {
    config?: { id?: string };
  } | null;
  const workspaceId = workspace?.config?.id ?? "default";

  const sessions = new SessionManager({
    rpc: bridge as RpcBridge,
    hostPrincipalId: appId,
    viewport: {
      columns: process.stdout.columns ?? 80,
      rows: Math.max(1, (process.stdout.rows ?? 24) - 2), // reserve header + footer
    },
  });

  const hostState = { overlayOpen: false };
  registerHostService(bridge as RpcBridge, {
    sessions,
    // Host keeps the real TTY in raw mode while running; only allow enabling.
    setRealRawMode: (enabled) => {
      if (enabled) process.stdin.setRawMode?.(true);
    },
    isOverlayOpen: () => hostState.overlayOpen,
  });

  const approvals = createApprovalsClient(bridge as RpcBridge);
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

if (process.env["NATSTACK_TERMINAL_APP_GATEWAY_URL"]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

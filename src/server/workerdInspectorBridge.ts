/**
 * WorkerdInspectorBridge — server-side relay between userland V8-inspector
 * clients (profiling via @workspace/testkit) and the local workerd inspector
 * socket.
 *
 * Architecture:
 *   Runtime client → /workerd-inspector/{encodedTargetPath} WS → this bridge
 *     → ws://127.0.0.1:<inspectorPort>/<targetPath> (workerd --inspector-addr)
 *
 * The inspector socket binds loopback and is unreachable from userland
 * (workers egress through the proxy; panels are not server-local), so this
 * bridge is the only programmatic path. Clients authenticate before upgrade
 * with the same opaque grant transport as the CDP bridge. The client↔upstream
 * protocol is plain V8 inspector JSON, relayed verbatim.
 */
import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { CDP_INTERNAL_GRANT_HEADER, CdpGrantService } from "@vibestudio/shared/cdpGrants";
import { createDevLogger } from "@vibestudio/dev-log";
import { parseWebSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";

const log = createDevLogger("WorkerdInspectorBridge");

export const WORKERD_INSPECTOR_PATH_PREFIX = "/workerd-inspector/";
export const WORKERD_INSPECTOR_PENDING_COMMAND_MAX_MESSAGES = 256;
export const WORKERD_INSPECTOR_PENDING_COMMAND_MAX_BYTES = 1024 * 1024;

export interface WorkerdInspectorTarget {
  id: string;
  title: string;
  type: string;
  /** Path component to pass to getEndpoint (from webSocketDebuggerUrl). */
  targetPath: string;
}

export interface WorkerdInspectorBridgeOptions {
  /** Base inspector URL, e.g. http://127.0.0.1:9229 — null when disabled. */
  getInspectorUrl: () => string | null;
  protocol?: "http" | "https";
  externalHost?: string;
  port: number;
  /** Test seam for the server-owned upstream inspector transport. */
  createUpstreamSocket?: (url: string) => WebSocket;
}

interface ProxiedSession {
  client: WebSocket;
  upstream: WebSocket;
}

export class WorkerdInspectorBridge {
  private readonly grants = new CdpGrantService();
  private readonly sessions = new Set<ProxiedSession>();

  constructor(private readonly options: WorkerdInspectorBridgeOptions) {}

  /** List live inspector targets via the inspector's /json/list endpoint. */
  async listTargets(): Promise<WorkerdInspectorTarget[]> {
    const base = this.options.getInspectorUrl();
    if (!base) return [];
    const response = await fetch(`${base}/json/list`);
    if (!response.ok) {
      throw new Error(`workerd inspector /json/list failed: ${response.status}`);
    }
    const rows = (await response.json()) as Array<{
      id?: string;
      title?: string;
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    return rows
      .map((row) => {
        let targetPath = row.id ?? "";
        if (row.webSocketDebuggerUrl) {
          try {
            targetPath = new URL(row.webSocketDebuggerUrl).pathname.replace(/^\//, "");
          } catch {
            // Keep the id fallback.
          }
        }
        return {
          id: row.id ?? targetPath,
          title: row.title ?? row.id ?? targetPath,
          type: row.type ?? "node",
          targetPath,
        };
      })
      .filter((target) => target.targetPath.length > 0);
  }

  /** Mint a single-use endpoint for a target path. Null when disabled. */
  getEndpoint(
    targetPath: string,
    principalId: string
  ): { wsEndpoint: string; token: string } | null {
    if (!this.options.getInspectorUrl()) return null;
    const { token } = this.grants.grant(principalId, `workerd-inspector:${targetPath}`);
    const wsProtocol = this.options.protocol === "https" ? "wss" : "ws";
    const host = this.options.externalHost ?? "127.0.0.1";
    const encoded = encodeURIComponent(targetPath);
    return {
      wsEndpoint: `${wsProtocol}://${host}:${this.options.port}${WORKERD_INSPECTOR_PATH_PREFIX}${encoded}`,
      token,
    };
  }

  isInspectorPath(pathname: string): boolean {
    return pathname.startsWith(WORKERD_INSPECTOR_PATH_PREFIX);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.isInspectorPath(url.pathname)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const targetPath = decodeURIComponent(url.pathname.slice(WORKERD_INSPECTOR_PATH_PREFIX.length));
    const inspectorBase = this.options.getInspectorUrl();
    if (!inspectorBase || targetPath.length === 0) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const internalGrant = req.headers[CDP_INTERNAL_GRANT_HEADER];
    const token =
      (typeof internalGrant === "string" ? internalGrant : null) ??
      parseWebSocketAuthProtocol(req.headers["sec-websocket-protocol"], "inspection");
    if (!token || !this.grants.redeem(token, `workerd-inspector:${targetPath}`)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      this.proxy(client, targetPath, inspectorBase);
    });
  }

  /** Close all proxied sessions (e.g. before a workerd restart). */
  closeAll(): void {
    for (const session of this.sessions) {
      session.client.close(1012, "workerd restarting");
      if (session.upstream.readyState === WebSocket.CONNECTING) session.upstream.terminate();
      else if (session.upstream.readyState === WebSocket.OPEN) session.upstream.close();
    }
    this.sessions.clear();
  }

  stop(): void {
    this.closeAll();
    this.grants.stop();
  }

  private proxy(client: WebSocket, targetPath: string, inspectorBase: string): void {
    const upstreamUrl = `${inspectorBase.replace(/^http/, "ws")}/${targetPath}`;
    const upstream = this.options.createUpstreamSocket?.(upstreamUrl) ?? new WebSocket(upstreamUrl);
    const session: ProxiedSession = { client, upstream };
    this.sessions.add(session);
    const pendingCommands: string[] = [];
    let pendingCommandBytes = 0;
    let tornDown = false;

    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      this.sessions.delete(session);
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };

    // Install both directions immediately. The downstream upgrade completes
    // before the loopback inspector connection can open, and real CDP clients
    // send commands as soon as their socket opens.
    client.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString();
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
        return;
      }
      if (upstream.readyState !== WebSocket.CONNECTING) return;
      const messageBytes = Buffer.byteLength(message, "utf8");
      if (
        pendingCommands.length >= WORKERD_INSPECTOR_PENDING_COMMAND_MAX_MESSAGES ||
        pendingCommandBytes + messageBytes > WORKERD_INSPECTOR_PENDING_COMMAND_MAX_BYTES
      ) {
        log.warn(`pending inspector command limit exceeded for ${targetPath}`);
        client.close(1009, "Inspector command queue exceeded readiness limit");
        teardown();
        return;
      }
      pendingCommands.push(message);
      pendingCommandBytes += messageBytes;
    });
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(typeof data === "string" ? data : data.toString());
      }
    });
    upstream.on("open", () => {
      if (tornDown) return;
      for (const message of pendingCommands) upstream.send(message);
      pendingCommands.length = 0;
      pendingCommandBytes = 0;
    });
    upstream.on("error", (error) => {
      log.warn(`upstream inspector socket error for ${targetPath}: ${String(error)}`);
      teardown();
    });
    upstream.on("close", teardown);
    client.on("close", teardown);
    client.on("error", teardown);
  }
}

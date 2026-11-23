import { connect } from "node:net";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { EgressListener } from "./egressListener.js";
import {
  resolveNetworkDestination,
  parseConnectAuthority,
  type NetworkEndpointAuthority,
} from "./networkDestination.js";
import { forwardPinnedHttpRequest } from "./pinnedHttpForward.js";
import { bridgeDuplexSockets, consumeSocketErrorsUntilClose } from "./socketBridge.js";

/** Native-local browser transport, with no credential injection or unchecked DNS lookup. */
export class ChromiumNetworkProxy {
  private readonly retired = new AbortController();
  private readonly listener: EgressListener;
  readonly ready: Promise<string>;
  constructor(private readonly authority: NetworkEndpointAuthority = { kind: "public" }) {
    this.listener = new EgressListener({
      request: (req, res) => {
        const cancel = this.requestSignal(req);
        void (async () => {
          const target = httpTarget(req.url ?? "");
          const destination = await resolveNetworkDestination(
            target,
            this.destinationAuthority(target),
            cancel.signal
          );
          const headers: OutgoingHttpHeaders = { ...req.headers, host: target.host };
          // Proxy credentials and hop-by-hop fields never reach the destination.
          const hop = String(headers.connection ?? "")
            .split(",")
            .map((v) => v.trim().toLowerCase());
          for (const key of [
            ...hop,
            "connection",
            "proxy-authorization",
            "proxy-connection",
            "keep-alive",
            "upgrade",
            "te",
            "trailer",
            "transfer-encoding",
          ])
            delete headers[key];
          await forwardPinnedHttpRequest(req, res, target, headers, destination, cancel.signal);
        })()
          .catch(() => {
            if (res.destroyed) return;
            if (!res.headersSent) res.writeHead(403);
            res.end();
          })
          .finally(cancel.stop);
      },
      connect: (req, socket, head) => {
        consumeSocketErrorsUntilClose(socket);
        const cancel = this.requestSignal(req);
        socket.once("close", cancel.abort);
        void (async () => {
          const target = parseConnectAuthority(req.url ?? "").url;
          const destination = await resolveNetworkDestination(
            target,
            this.destinationAuthority(target),
            cancel.signal
          );
          const upstream = connect({
            host: destination.hostname,
            port: Number(target.port || 443),
            lookup: destination.lookup,
            signal: cancel.signal,
          });
          consumeSocketErrorsUntilClose(upstream);
          upstream.once("error", () => socket.destroy());
          upstream.once("connect", () => {
            if (socket.destroyed) {
              upstream.destroy();
              return;
            }
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            bridgeDuplexSockets(socket, upstream);
          });
          upstream.once("close", cancel.stop);
        })().catch(() => {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          cancel.stop();
        });
      },
      // WebSocket cleartext upgrade is not a document fetch. WSS uses the same vetted CONNECT path.
      upgrade: (_req, socket) => socket.destroy(),
    });
    this.ready = this.listener.ready.then((port) => `http://127.0.0.1:${port}`);
  }
  private destinationAuthority(target: URL): NetworkEndpointAuthority {
    // An explicit local grant adds one origin; it does not revoke ordinary public subresources.
    return this.authority.kind === "internal-loopback" && target.origin === this.authority.origin
      ? this.authority
      : { kind: "public" };
  }
  private requestSignal(req: IncomingMessage) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    return {
      signal: AbortSignal.any([controller.signal, this.retired.signal]),
      abort,
      stop: () => req.off("aborted", abort),
    };
  }
  async close(): Promise<void> {
    this.retired.abort();
    await this.listener.close();
  }
}
function httpTarget(raw: string): URL {
  const target = new URL(raw);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new Error("Expected an HTTP(S) network endpoint");
  return target;
}

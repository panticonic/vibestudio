/**
 * Fixtures for tests that run the real runtime on the celld fork.
 *
 * A workspace's node sends every outbound request through one egress proxy and
 * reaches the gateway (`GATEWAY_URL`) through it too, so a test stands up one
 * HTTP server in both roles: `nodeProxy` wraps a gateway handler, verifies the
 * identity celld stamps on each request with the same code the product proxy
 * uses, serves host-program traffic (the runtime application's own calls to
 * the gateway) from the gateway handler with a relative URL, and answers
 * traffic of loaded or product code itself.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { connect, createServer } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CelldNode, type CelldNodeProcess } from "../../src/server/celldNode.js";
import {
  celldEgressSubject,
  verifyCelldEgress,
  type CelldEgressIdentity,
} from "../../src/server/services/celldEgressIdentity.js";

/** The fork binary the tests run on: `VIBESTUDIO_CELLD_BIN`, or the staged payload. */
export function celldTestBinary(): string | null {
  const configured = process.env["VIBESTUDIO_CELLD_BIN"];
  if (configured) return path.isAbsolute(configured) && existsSync(configured) ? configured : null;
  const staged = path.resolve(
    "native",
    "celld",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "celld.exe" : "celld"
  );
  return existsSync(staged) ? staged : null;
}

export interface NodeTraffic {
  readonly identity: CelldEgressIdentity;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  /** The request itself, for a handler that serves it. */
  readonly request: IncomingMessage;
}

export interface NodeProxyOptions {
  readonly secret: string;
  /** Serves the gateway: loader endpoints and the like, with a relative `req.url`. */
  readonly gateway: (req: IncomingMessage, res: ServerResponse) => void;
  /** Answers traffic that is not a host program's. Default: who the node says it is. */
  readonly other?: (traffic: NodeTraffic, res: ServerResponse) => void;
}

export function nodeProxy(options: NodeProxyOptions) {
  const traffic: NodeTraffic[] = [];
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const identity = verifyCelldEgress({
      headers: req.headers,
      kind: "fetch",
      method: req.method ?? "",
      target: req.url ?? "",
      secret: options.secret,
    });
    const subject = identity ? celldEgressSubject(identity) : null;
    if (!identity || !subject) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("unattributed");
      return;
    }
    if (subject.kind === "host-program") {
      const target = new URL(req.url ?? "", "http://gateway");
      req.url = `${target.pathname}${target.search}`;
      options.gateway(req, res);
      return;
    }
    const seen: NodeTraffic = { identity, url: req.url ?? "", headers: req.headers, request: req };
    traffic.push(seen);
    if (options.other) {
      options.other(seen, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ seenCaller: subject.callerId }));
  };
  return { listener, traffic };
}

// ---------------------------------------------------------------------------
// A probe: one bundled module with Durable Object classes on its own node.
// ---------------------------------------------------------------------------


async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

export interface CelldProbeOptions {
  /** Scratch directory the probe owns (deployment project, bucket, working set). */
  readonly root: string;
  /** One ES module: a default `fetch` handler and the classes named below. */
  readonly bundle: string;
  /** SQLite Durable Object classes; each is bound under its upper-case name
   *  unless `bindings` names them. */
  readonly classes: readonly string[];
  readonly bindings?: ReadonlyArray<{ readonly name: string; readonly class_name: string }>;
  /** Bind a Worker Loader as `LOADER`. */
  readonly loader?: boolean;
  readonly vars?: Readonly<Record<string, string>>;
  readonly compatibilityFlags?: readonly string[];
  readonly inspector?: boolean;
  /** Route egress through this proxy (default: the probe dials out itself). */
  readonly egress?: { readonly url: string; readonly secret: string };
  readonly onOutput?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface CelldProbe {
  readonly endpoint: string;
  readonly inspectorPort: number | null;
  /** The running node (undefined between `stop` and `start`). */
  node(): CelldNodeProcess;
  /** Same-node durable stop: the node makes its cells durable and exits. */
  stop(): Promise<void>;
  /** Start a node over the same bucket (a replaced process, the same cells). */
  start(): Promise<void>;
  /** Kill the node without its durable stop (a crash). */
  kill(): Promise<void>;
}

export async function startCelldProbe(options: CelldProbeOptions): Promise<CelldProbe> {
  const binary = celldTestBinary();
  if (!binary) throw new Error("No celld binary: set VIBESTUDIO_CELLD_BIN");
  const listen = await freePort();
  const inspector = options.inspector ? await freePort() : null;
  const node = new CelldNode({
    binary,
    stateDir: path.join(options.root, "celld"),
    blobRoot: path.join(options.root, "blobs"),
    nodeId: "probe-node",
    ...(options.egress ? { egressProxyUrl: options.egress.url, egressSecret: options.egress.secret } : {}),
    onOutput: options.onOutput ?? (() => undefined),
  });
  await node.deploy(options.bundle, {
    name: "probe",
    compatibility_date: "2025-12-01",
    compatibility_flags: [...(options.compatibilityFlags ?? ["nodejs_compat"])],
    ...(options.loader ? { worker_loaders: [{ binding: "LOADER" }] } : {}),
    ...(options.classes.length > 0
      ? {
          durable_objects: {
            bindings:
              options.bindings ??
              options.classes.map((name) => ({ name: name.toUpperCase(), class_name: name })),
          },
          migrations: [{ tag: "v1", new_sqlite_classes: [...options.classes] }],
        }
      : {}),
    vars: { ...(options.vars ?? {}) },
  });
  let running: CelldNodeProcess | null = null;
  const probe: CelldProbe = {
    endpoint: `http://127.0.0.1:${listen}`,
    inspectorPort: inspector,
    node: () => {
      if (!running) throw new Error("The probe node is not running");
      return running;
    },
    async start() {
      const started = node.start({ listen, inspector });
      running = started;
      // Ready when the listener accepts a connection; no request is made, so
      // the probe's own handler never sees one it did not expect.
      for (;;) {
        if (started.hasExited) throw new Error("celld exited before it served");
        const accepted = await new Promise<boolean>((resolve) => {
          const socket = connect({ host: "127.0.0.1", port: listen });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        if (accepted) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async stop() {
      const current = running;
      if (!current) return;
      const asked = await current.requestShutdown();
      if (!asked) current.child.kill("SIGTERM");
      await current.exited;
      running = null;
    },
    async kill() {
      const current = running;
      if (!current) return;
      current.child.kill("SIGKILL");
      await current.exited;
      running = null;
    },
  };
  return probe;
}

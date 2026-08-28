#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  bindNodeEndpoint,
  endpointAddrForRelay,
  loadIrohNodeBinding,
  VIBESTUDIO_IROH_ALPN,
} from "../packages/iroh-transport/src/node.js";

const RELAY_URL = "http://127.0.0.1:3340/";
const STARTUP_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 10_000;

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForRelay(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Pinned Iroh relay fixture exited before accepting connections");
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: 3340 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error("Pinned Iroh relay fixture did not become ready");
    await delay(50);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await bounded(
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    "relay fixture shutdown",
    5_000
  ).catch(async () => {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  });
}

const child = spawn(process.execPath, ["scripts/iroh-relay-fixture.mjs", "--", "--dev"], {
  cwd: process.cwd(),
  stdio: ["ignore", "inherit", "inherit"],
});
const endpoints: Array<Awaited<ReturnType<typeof bindNodeEndpoint>>> = [];

try {
  await waitForRelay(child);
  const { SecretKey } = loadIrohNodeBinding();
  const server = await bindNodeEndpoint({
    secretKey: SecretKey.generate(),
    relayUrls: [RELAY_URL],
  });
  endpoints.push(server);
  const client = await bindNodeEndpoint({
    secretKey: SecretKey.generate(),
    relayUrls: [RELAY_URL],
  });
  endpoints.push(client);
  await bounded(
    Promise.all([server.online(), client.online()]),
    "relay registration",
    OPERATION_TIMEOUT_MS
  );

  const incomingPromise = server.acceptNext();
  const clientConnectionPromise = client.connect(
    endpointAddrForRelay(server.id().toString(), RELAY_URL),
    [...VIBESTUDIO_IROH_ALPN]
  );
  const incoming = await bounded(incomingPromise, "relay accept", OPERATION_TIMEOUT_MS);
  if (!incoming) throw new Error("Server endpoint closed before accepting the relayed connection");
  const [serverConnection, clientConnection] = await bounded(
    Promise.all([
      incoming.accept().then((accepting) => accepting.connect()),
      clientConnectionPromise,
    ]),
    "relayed handshake",
    OPERATION_TIMEOUT_MS
  );
  try {
    const serverPaths = serverConnection.paths();
    const clientPaths = clientConnection.paths();
    const usedRelay = (paths: typeof serverPaths) =>
      paths.some((path) => path.isRelay && path.stats.udpTxBytes > 0 && path.stats.udpRxBytes > 0);
    if (!usedRelay(serverPaths) || !usedRelay(clientPaths)) {
      throw new Error(
        `Expected both peers to exchange relay traffic, received ${JSON.stringify({ serverPaths, clientPaths })}`
      );
    }
    const serverStreamPromise = serverConnection.acceptBi();
    const clientStream = await clientConnection.openBi();
    await clientStream.send.writeAll([0x49, 0x52, 0x4f, 0x48]);
    await clientStream.send.finish();
    const serverStream = await bounded(serverStreamPromise, "relayed stream", OPERATION_TIMEOUT_MS);
    const message = await bounded(
      serverStream.recv.readToEnd(4),
      "relayed read",
      OPERATION_TIMEOUT_MS
    );
    if (Buffer.from(message).toString("ascii") !== "IROH") {
      throw new Error("Relayed stream payload was corrupted");
    }
    console.log(`[iroh-relay-fixture] passed via ${RELAY_URL}`);
  } finally {
    serverConnection.close(0n, []);
    clientConnection.close(0n, []);
  }
} finally {
  await Promise.all(endpoints.map((endpoint) => endpoint.close().catch(() => undefined)));
  await stopChild(child);
}

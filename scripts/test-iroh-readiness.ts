/** Native outage acceptance. Uses only an owned loopback relay and endpoints.
 * Run with a deliberately selected NAPI_RS_NATIVE_LIBRARY_PATH to test a repair.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createNodeEndpointBinding,
  loadIrohNodeBinding,
} from "../packages/iroh-transport/src/node.js";
import { startIrohIngress } from "../src/server/irohIngress.js";

async function bounded<T>(work: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const relayBinary = execFileSync(
  process.execPath,
  ["scripts/iroh-relay-fixture.mjs", "--print-path"],
  { encoding: "utf8" }
).trim();
const directory = await mkdtemp(join(tmpdir(), "iroh-readiness-"));
const sockets = new Set<Socket>();
const stalled = createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
});
let relay: ChildProcess | undefined;
let ingress: ReturnType<typeof startIrohIngress> | undefined;
let relayOutput = "";
try {
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  const address = stalled.address();
  assert(address && typeof address !== "string");
  const binding = createNodeEndpointBinding({
    secretKey: loadIrohNodeBinding().SecretKey.generate(),
    relayUrls: [`http://127.0.0.1:${address.port}/`],
  });
  let binds = 0;
  ingress = startIrohIngress({
    binding: {
      bind: () => {
        binds++;
        return binding.bind();
      },
    },
    waitUntilOnline: (endpoint) => endpoint.native.online(),
    admitPeer: () => false,
    attach: async () => {},
  });
  let ready = false;
  const readiness = ingress.ready.then(() => {
    ready = true;
  });
  // Attach a handler immediately, even while deliberately holding the outage.
  void readiness.catch(() => {});
  await delay(16_000);
  assert.equal(ready, false);
  assert.equal(binds, 1);
  assert(sockets.size > 0, "native endpoint must attempt the stalled relay");
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => stalled.close(() => resolve()));
  const config = join(directory, "relay.toml");
  await writeFile(
    config,
    `http_bind_addr = "127.0.0.1:${address.port}"\nenable_quic_addr_discovery = false\n`
  );
  relay = spawn(relayBinary, ["--dev", "--config-path", config], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout?.on("data", (chunk) => {
    relayOutput += String(chunk);
  });
  relay.stderr?.on("data", (chunk) => {
    relayOutput += String(chunk);
  });
  await bounded(readiness, "relay recovery", 45_000);
  assert.equal(binds, 1, "recovery must preserve the endpoint");
  await bounded(ingress.stop(), "online ingress shutdown");
  ingress = undefined;

  // No relays: online can never succeed. Closing must reject every native wait.
  const offline = await createNodeEndpointBinding({
    secretKey: loadIrohNodeBinding().SecretKey.generate(),
  }).bind();
  const waits = Array.from({ length: 8 }, () => assert.rejects(offline.native.online(), /closed/i));
  await bounded(offline.close(), "offline endpoint close");
  await bounded(Promise.all(waits), "native readiness cancellation");
  await bounded(assert.rejects(offline.native.online(), /closed/i), "readiness after close");
  console.log(
    "PASS: same endpoint recovered after 16s relay outage; native readiness cancelled on close."
  );
} catch (error) {
  console.error(relayOutput);
  throw error;
} finally {
  for (const socket of sockets) socket.destroy();
  const cleanup = await Promise.allSettled([
    ingress ? bounded(ingress.stop(), "ingress cleanup") : Promise.resolve(),
    stalled.listening
      ? new Promise<void>((resolve) => stalled.close(() => resolve()))
      : Promise.resolve(),
    (async () => {
      if (relay && relay.exitCode === null && relay.signalCode === null) {
        const exited = once(relay, "exit");
        relay.kill("SIGTERM");
        try {
          await bounded(exited, "relay shutdown");
        } catch {
          relay.kill("SIGKILL");
          await exited;
        }
      }
    })(),
  ]);
  await rm(directory, { recursive: true, force: true });
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Readiness fixture cleanup failed"
    );
}

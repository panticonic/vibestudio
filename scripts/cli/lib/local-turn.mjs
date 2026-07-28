import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function isPrivateIpv4(address) {
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  const match = address.match(/^172\.(\d{1,2})\./);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

/** Private host address reachable by both QEMU NAT and the host-side answerer. */
export function privateLanIpv4(networkInterfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) {
        candidates.push(address.address);
      }
    }
  }
  return (
    candidates.find((address) => address.startsWith("192.168.")) ??
    candidates.find((address) => address.startsWith("10.")) ??
    candidates[0] ??
    null
  );
}

export function signalingTurnVars(turn) {
  if (!turn) return [];
  return [
    "--var",
    `VIBESTUDIO_LOCAL_TURN_HOST:${turn.host}`,
    "--var",
    `VIBESTUDIO_LOCAL_TURN_PORT:${turn.port}`,
    "--var",
    `VIBESTUDIO_LOCAL_TURN_USER:${turn.user}`,
    "--var",
    `VIBESTUDIO_LOCAL_TURN_PASS:${turn.pass}`,
  ];
}

export function requiresLocalTurn({ launchedEmulator = false, device = null } = {}) {
  return launchedEmulator || String(device ?? "").startsWith("emulator-");
}

export function relayOnlyServerEnv(turn) {
  return turn ? { VIBESTUDIO_WEBRTC_ICE: "relay" } : {};
}

async function allocateTcpPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Could not allocate a local TURN port"));
      });
    });
  });
}

async function probeTurnUdp(host, port, timeoutMs = 5_000) {
  const transactionId = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4);
  transactionId.copy(request, 8);

  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const deadline = Date.now() + timeoutMs;
    let timer;
    const finish = (error) => {
      if (timer) clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const attempt = () => {
      if (Date.now() >= deadline) {
        finish(new Error(`coturn did not answer a STUN binding probe on ${host}:${port}`));
        return;
      }
      socket.send(request, Number(port), host);
      timer = setTimeout(attempt, 100);
    };
    socket.once("error", finish);
    socket.on("message", (message) => {
      if (
        message.length >= 20 &&
        message.readUInt32BE(4) === 0x2112a442 &&
        message.subarray(8, 20).equals(transactionId)
      ) {
        finish();
      }
    });
    attempt();
  });
}

/**
 * Start the relay required by Android Emulator/QEMU NAT. There is deliberately
 * no direct-ICE fallback: setup completes only after a real STUN response.
 */
export async function startLocalTurnRelay({
  spawnManaged,
  waitForSpawn,
  networkInterfaces = os.networkInterfaces(),
  tempDir = os.tmpdir(),
  pid = process.pid,
  allocatePort = allocateTcpPort,
  probeReady = probeTurnUdp,
}) {
  const host = privateLanIpv4(networkInterfaces);
  if (!host) throw new Error("No private LAN IPv4 found for the local TURN relay");

  const port = String(await allocatePort());
  const user = `vs-${randomBytes(9).toString("base64url")}`;
  const pass = randomBytes(24).toString("base64url");
  const suffix = `${pid}-${Date.now()}`;
  const configPath = path.join(tempDir, `vibestudio-coturn-${suffix}.conf`);
  const pidPath = path.join(tempDir, `vibestudio-coturn-${suffix}.pid`);
  const cleanupArtifacts = async () => {
    await Promise.all([fsp.rm(configPath, { force: true }), fsp.rm(pidPath, { force: true })]);
  };

  await fsp.writeFile(
    configPath,
    [
      `listening-port=${port}`,
      `listening-ip=${host}`,
      `relay-ip=${host}`,
      "realm=vibestudio.local",
      "lt-cred-mech",
      `user=${user}:${pass}`,
      "no-tls",
      "no-dtls",
      "no-cli",
      "no-tcp-relay",
      `allowed-peer-ip=${host}`,
      `pidfile=${pidPath}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  let child = null;
  try {
    child = spawnManaged("turnserver", ["-c", configPath], { label: "coturn" });
    await waitForSpawn(child, "turnserver", ["-c", configPath]);
    if (child.exitCode != null) {
      throw new Error(`coturn exited before readiness with code ${child.exitCode}`);
    }
    await probeReady(host, port);
    if (child.exitCode != null) {
      throw new Error(`coturn exited during readiness with code ${child.exitCode}`);
    }
    return { child, host, port, user, pass, configPath, pidPath, cleanupArtifacts };
  } catch (error) {
    if (child?.exitCode == null && !child?.killed) child?.kill("SIGTERM");
    await cleanupArtifacts();
    throw new Error(
      `Local TURN relay is required for Android Emulator/QEMU NAT: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

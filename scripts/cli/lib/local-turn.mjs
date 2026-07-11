import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
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

/**
 * Start the relay required by Android Emulator/QEMU NAT. There is deliberately
 * no direct-ICE fallback: failure to spawn or early coturn exit rejects setup.
 */
export async function startLocalTurnRelay({
  spawnManaged,
  waitForSpawn,
  sleep,
  networkInterfaces = os.networkInterfaces(),
  tempDir = os.tmpdir(),
  pid = process.pid,
}) {
  const host = privateLanIpv4(networkInterfaces);
  if (!host) throw new Error("No private LAN IPv4 found for the local TURN relay");

  const port = "47000";
  const user = `vs-${randomBytes(9).toString("base64url")}`;
  const pass = randomBytes(24).toString("base64url");
  const suffix = `${pid}-${Date.now()}`;
  const configPath = path.join(tempDir, `vibestudio-coturn-${suffix}.conf`);
  const pidPath = path.join(tempDir, `vibestudio-coturn-${suffix}.pid`);
  const cleanupArtifacts = async () => {
    await Promise.all([
      fsp.rm(configPath, { force: true }),
      fsp.rm(pidPath, { force: true }),
    ]);
  };

  await fsp.writeFile(
    configPath,
    [
      `listening-port=${port}`,
      "listening-ip=127.0.0.1",
      `listening-ip=${host}`,
      `relay-ip=${host}`,
      "realm=vibestudio.local",
      "lt-cred-mech",
      `user=${user}:${pass}`,
      "no-tls",
      "no-dtls",
      `allowed-peer-ip=${host}`,
      "min-port=48000",
      "max-port=48100",
      `pidfile=${pidPath}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  let child = null;
  try {
    child = spawnManaged("turnserver", ["-c", configPath], { label: "coturn" });
    await waitForSpawn(child, "turnserver", ["-c", configPath]);
    await sleep(1_500);
    if (child.exitCode != null) {
      throw new Error(`coturn exited before readiness with code ${child.exitCode}`);
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

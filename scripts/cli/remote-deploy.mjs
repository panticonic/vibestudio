#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { printConnectBanner } from "./lib/connect-banner.mjs";
import { parseHubReadyPayload } from "./lib/hub-ready.mjs";
import { DEFAULT_IROH_RELAYS } from "./lib/iroh-relays.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const SERVER_PACKAGE_NAME = "@panticonic/vibestudio-server";
const MANAGED_READY_FILE_RELATIVE = ".config/vibestudio/server-auth/hub-ready.json";
const nodeEngineMatch = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines?.node ?? "");
if (!nodeEngineMatch) {
  throw new Error("package.json engines.node must be an exact >=major.minor.patch requirement");
}
export const REQUIRED_NODE_VERSION = nodeEngineMatch.slice(1).map(Number);
const REQUIRED_NODE_VERSION_TEXT = REQUIRED_NODE_VERSION.join(".");

export function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help")) {
    return {
      verb: "deploy",
      target: null,
      artifact: null,
      relayUrls: [...DEFAULT_IROH_RELAYS],
      port: "3030",
      purge: false,
      help: true,
    };
  }
  const verb = ["status", "logs", "pairing", "update", "remove"].includes(args[0])
    ? args.shift()
    : "deploy";
  const options = {
    verb,
    target: args.shift() ?? null,
    artifact: null,
    relayUrls: [],
    port: "3030",
    purge: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") options.artifact = path.resolve(args[++i] ?? "");
    else if (arg === "--relay-url") {
      const raw = args[++i];
      if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
        throw new Error(`${arg} requires one relay URL without control characters`);
      }
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.toString() !== raw) {
        throw new Error("Relay URL must be canonical, credential-free HTTPS");
      }
      options.relayUrls.push(raw);
    } else if (arg === "--port") {
      const raw = args[++i];
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer from 1 to 65535");
      }
      options.port = String(port);
    } else if (arg === "--purge") options.purge = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.relayUrls.length === 0) options.relayUrls = [...DEFAULT_IROH_RELAYS];
  if (
    options.relayUrls.length > 8 ||
    new Set(options.relayUrls).size !== options.relayUrls.length
  ) {
    throw new Error("Pass between one and eight distinct --relay-url values");
  }
  return options;
}

export function printHelp() {
  console.log(`vibestudio remote deploy

Usage:
  vibestudio remote deploy <user@host|local> [--artifact <tgz>] [--relay-url <https-url>...] [--port 3030]
  vibestudio remote deploy status <user@host|local>
  vibestudio remote deploy logs <user@host|local>
  vibestudio remote deploy pairing <user@host|local>
  vibestudio remote deploy update <user@host|local> [--artifact <tgz>] [--relay-url <https-url>...] [--port 3030]
  vibestudio remote deploy remove <user@host|local> [--purge]

Deploys a systemd user unit named vibestudio-server. With --artifact, the
tarball is installed with npm install -g. Without --artifact, the target
installs the invoking CLI package/version from npm. Use \`local\` to make this
computer the server without SSH. The target must run Node.js ${pkg.engines.node}.
Remove leaves workspace source intact. --purge also removes the installed npm
package and every workspace child's Iroh endpoint secret. Hub identity,
accounts, and device pairing remain intact; clients obtain fresh workspace
reaches through the stable hub control ingress after reinstall.
`);
}

export function managedReadyFile(home = os.homedir()) {
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new Error("Cannot resolve the current user's home directory for managed pairing state");
  }
  return path.join(home, MANAGED_READY_FILE_RELATIVE);
}

async function readHealth(fetchImpl, url, label) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(
      `${label} is unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`${label} is unavailable (HTTP ${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned malformed health data`);
  }
}

/** Display the one current root invite from the managed server's protected
 * ready-state contract. The journal is diagnostic output, never a secret API. */
export async function showManagedPairing({
  readyFile = managedReadyFile(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let stat;
  try {
    stat = fs.lstatSync(readyFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Managed pairing state is not ready at ${readyFile}; check \`vibestudio remote deploy status local\``
      );
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Managed pairing state is not a regular file: ${readyFile}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Managed pairing state has unsafe permissions at ${readyFile}; expected mode 0600`
    );
  }

  let ready;
  try {
    ready = parseHubReadyPayload(JSON.parse(fs.readFileSync(readyFile, "utf8")));
  } catch (error) {
    throw new Error(
      `Managed pairing state is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const hubHealth = await readHealth(
    fetchImpl,
    new URL("/healthz", ready.gatewayUrl),
    "Managed Vibestudio hub"
  );
  for (const field of ["serverId", "serverBootId", "pid", "buildId"]) {
    if (hubHealth?.[field] !== ready[field]) {
      throw new Error(
        `Managed pairing state does not belong to the running hub (${field} mismatch)`
      );
    }
  }
  const invite = ready.rootInvite;
  if (!invite) {
    console.log(
      "Root account already claimed. Create another device invite from a paired desktop, mobile, or CLI client."
    );
    return ready;
  }
  const defaultWorkspace = ready.workspaces.find((workspace) => workspace.name === "default");
  if (!defaultWorkspace) {
    throw new Error("The managed server has no default workspace");
  }
  await readHealth(
    fetchImpl,
    new URL("/_workspace/default/healthz", ready.gatewayUrl),
    "Managed default workspace"
  );

  if (invite.expiresAt <= now()) {
    throw new Error("The root pairing invite is renewing; run this command again in a moment");
  }
  printConnectBanner({
    title: "Pair the first Vibestudio device",
    invite,
    deepLinkLabel: "Pair URL",
    instructions: "Open the link on a desktop, or scan the QR with the Vibestudio mobile app.",
  });
  console.log(`  Expires: ${new Date(invite.expiresAt).toISOString()}`);
  return ready;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = typeof options.input === "string";
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: hasInput ? ["pipe", "inherit", "inherit"] : (options.stdio ?? "inherit"),
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`))
    );
    if (hasInput) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function assertSafeTarget(target) {
  if (typeof target !== "string" || target.length === 0) throw new Error("missing <user@host>");
  if (target.startsWith("-")) {
    throw new Error(`refusing SSH target that looks like an option flag: ${target}`);
  }
  if (/\s/u.test(target)) throw new Error(`SSH target must not contain whitespace: ${target}`);
}

export async function ssh(target, script, hooks = {}) {
  assertSafeTarget(target);
  await (hooks.run ?? run)("ssh", [target, "bash", "-l", "-s"], { input: script });
}

/** Run one deployment script on either this computer or an SSH target. The
 * script is identical on both transports so local setup is not a second
 * lifecycle with different service, identity, or cleanup behavior. */
export async function targetShell(target, script, hooks = {}) {
  assertSafeTarget(target);
  if (target === "local") {
    await (hooks.run ?? run)("bash", ["-l", "-s"], { input: script });
    return;
  }
  await ssh(target, script, hooks);
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

const RESOLVE_REMOTE_RUNTIME = `node_bin=$(command -v node) || {
  echo "The installed Node.js executable is not on PATH" >&2
  exit 1
}
case "$node_bin" in
  /*) ;;
  *) echo "node resolved to a non-absolute path: $node_bin" >&2; exit 1 ;;
esac
case "$node_bin" in
  *[!A-Za-z0-9_./+@:-]*) echo "node path contains unsupported systemd characters" >&2; exit 1 ;;
esac
vibestudio_bin=$(command -v vibestudio) || {
  echo "The installed vibestudio executable is not on PATH" >&2
  exit 1
}
case "$vibestudio_bin" in
  /*) ;;
  *) echo "vibestudio resolved to a non-absolute path: $vibestudio_bin" >&2; exit 1 ;;
esac
case "$vibestudio_bin" in
  *[!A-Za-z0-9_./+@:-]*) echo "vibestudio path contains unsupported systemd characters" >&2; exit 1 ;;
esac
vibestudio_entry=$(readlink -f "$vibestudio_bin") || {
  echo "Could not resolve the installed vibestudio CLI entry" >&2
  exit 1
}
case "$vibestudio_entry" in
  /*) ;;
  *) echo "vibestudio entry resolved to a non-absolute path: $vibestudio_entry" >&2; exit 1 ;;
esac
case "$vibestudio_entry" in
  *[!A-Za-z0-9_./+@:-]*) echo "vibestudio entry contains unsupported systemd characters" >&2; exit 1 ;;
esac`;

export async function deploy(options, hooks = {}) {
  assertSafeTarget(options.target);
  if (options.artifact && !fs.existsSync(options.artifact))
    throw new Error(`artifact not found: ${options.artifact}`);
  const unitDir = "$HOME/.config/systemd/user";
  const relayEnv = `Environment=${systemdQuote(`VIBESTUDIO_IROH_RELAYS=${options.relayUrls.join(",")}`)}\n`;
  const requiredNodeTuple = JSON.stringify(REQUIRED_NODE_VERSION);
  console.log(
    options.target === "local"
      ? "✓ Deployment target          this computer"
      : `✓ SSH connection            ${options.target}`
  );
  await targetShell(
    options.target,
    `set -e
command -v node >/dev/null || { echo "Node.js ${REQUIRED_NODE_VERSION_TEXT}+ is required on the remote host" >&2; exit 1; }
node -e 'const actual=process.versions.node.split(".").map(Number); const required=${requiredNodeTuple}; const ok=actual[0]>required[0] || (actual[0]===required[0] && (actual[1]>required[1] || (actual[1]===required[1] && actual[2]>=required[2]))); if (!ok) { console.error("Node.js ${REQUIRED_NODE_VERSION_TEXT}+ is required, found " + process.version); process.exit(1); }'
if command -v systemctl >/dev/null; then
  systemctl --user --version >/dev/null
else
  echo "Unsupported init system: systemd user services are required" >&2
  exit 1
fi
mkdir -p ${unitDir}
if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
  if command -v sudo >/dev/null && sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1; then
    :
  else
    echo "linger setup requires privilege; run: sudo loginctl enable-linger $USER" >&2
    exit 42
  fi
fi
`,
    hooks
  );
  console.log("✓ Node.js                   remote runtime OK");

  if (options.artifact) {
    if (options.target === "local") {
      await targetShell(
        options.target,
        `set -e
npm install -g ${shellQuote(options.artifact)}
`,
        hooks
      );
    } else {
      const remoteArtifact = `/tmp/vibestudio-${Date.now()}.tgz`;
      await (hooks.run ?? run)("scp", [options.artifact, `${options.target}:${remoteArtifact}`]);
      await targetShell(
        options.target,
        `set -e
npm install -g ${shellQuote(remoteArtifact)}
rm -f ${shellQuote(remoteArtifact)}
`,
        hooks
      );
    }
    console.log(`✓ Installed artifact        ${path.basename(options.artifact)}`);
  } else {
    await targetShell(
      options.target,
      `set -e
npm install -g ${shellQuote(`${SERVER_PACKAGE_NAME}@${pkg.version}`)}
`,
      hooks
    );
    console.log(`✓ Installed package         ${SERVER_PACKAGE_NAME}@${pkg.version}`);
  }
  const serverCommand =
    `__NODE_BIN__ __VIBESTUDIO_ENTRY__ remote serve --port ${options.port} ` +
    `--ready-file "%h/${MANAGED_READY_FILE_RELATIVE}"`;
  const unit = `[Unit]
Description=Vibestudio remote server
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
UMask=0077
${relayEnv}ExecStart=${serverCommand}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  await targetShell(
    options.target,
    `set -e
${RESOLVE_REMOTE_RUNTIME}
cat > ${unitDir}/vibestudio-server.service <<'UNIT'
${unit}
UNIT
sed -i "s|__NODE_BIN__|$node_bin|g; s|__VIBESTUDIO_ENTRY__|$vibestudio_entry|g" ${unitDir}/vibestudio-server.service
systemctl --user daemon-reload
systemctl --user enable vibestudio-server.service
# restart (not just enable --now) so an UPDATE replaces the running old binary.
systemctl --user restart vibestudio-server.service
systemctl --user is-active --quiet vibestudio-server.service
ready_file="$HOME/${MANAGED_READY_FILE_RELATIVE}"
deadline=$((SECONDS + 120))
until [ -s "$ready_file" ] && "$node_bin" -e "Promise.all([fetch('http://127.0.0.1:${options.port}/healthz'), fetch('http://127.0.0.1:${options.port}/_workspace/default/healthz')]).then(async ([hubResponse, workspaceResponse]) => { if (!hubResponse.ok || !workspaceResponse.ok) return process.exit(1); const [hub, workspace] = await Promise.all([hubResponse.json(), workspaceResponse.json()]); process.exit(hub.ok && hub.mode === 'hub' && workspace.ok ? 0 : 1); }).catch(() => process.exit(1))"; do
  if ! systemctl --user is-active --quiet vibestudio-server.service; then
    journalctl --user -u vibestudio-server.service -n 100 --no-pager >&2
    echo "Vibestudio service exited before the hub and default workspace became ready" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    journalctl --user -u vibestudio-server.service -n 100 --no-pager >&2
    systemctl --user stop vibestudio-server.service
    echo "Timed out waiting for the hub, default workspace runtime, and managed pairing state; the failed service was stopped" >&2
    exit 1
  fi
  sleep 1
done
`,
    hooks
  );
  console.log("✓ systemd user service      vibestudio-server.service");
  const relayArgs = options.relayUrls
    .map((relayUrl) => ` --relay-url ${shellQuote(relayUrl)}`)
    .join("");
  await targetShell(
    options.target,
    `set -e
${RESOLVE_REMOTE_RUNTIME}
"$node_bin" "$vibestudio_entry" remote doctor${relayArgs}
"$node_bin" "$vibestudio_entry" remote doctor${relayArgs} --workspace default
"$node_bin" "$vibestudio_entry" remote deploy pairing local
`,
    hooks
  );
  console.log("✓ Server ready               default workspace");
  console.log(`  Pairing: vibestudio remote deploy pairing ${options.target}`);
  console.log(`  Logs:    vibestudio remote deploy logs ${options.target}`);
  console.log(`  Status:  vibestudio remote deploy status ${options.target}`);
  console.log(`  Update:  vibestudio remote deploy update ${options.target}`);
}

function removeScript(purge) {
  const base = `systemctl --user disable --now vibestudio-server.service || true
rm -f $HOME/.config/systemd/user/vibestudio-server.service
systemctl --user daemon-reload`;
  if (!purge) return base;
  return `${base}
npm uninstall -g ${SERVER_PACKAGE_NAME} >/dev/null 2>&1 || true
find $HOME/.config/vibestudio/workspaces -maxdepth 5 -type f -path '*/reach/iroh/endpoint.key' -delete 2>/dev/null || true
echo "Purged workspace Iroh endpoint secrets; hub pairing remains valid and clients must re-route workspaces after reinstall." >&2`;
}

export async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parseArgs([...argv]);
  if (options.help || !options.target) {
    printHelp();
    return options.help ? 0 : 1;
  }
  if (options.verb === "deploy" || options.verb === "update") return deploy(options, hooks);
  if (options.verb === "status")
    return targetShell(
      options.target,
      "systemctl --user --no-pager status vibestudio-server.service",
      hooks
    );
  if (options.verb === "logs")
    return targetShell(options.target, "journalctl --user -u vibestudio-server.service -f", hooks);
  if (options.verb === "pairing") {
    if (options.target === "local") {
      return (hooks.showManagedPairing ?? showManagedPairing)();
    }
    return targetShell(
      options.target,
      `set -e
${RESOLVE_REMOTE_RUNTIME}
"$node_bin" "$vibestudio_entry" remote deploy pairing local
`,
      hooks
    );
  }
  if (options.verb === "remove") {
    return targetShell(options.target, removeScript(options.purge), hooks);
  }
  throw new Error(`unknown verb: ${options.verb}`);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isDirectRun()) {
  main()
    .then((code) => {
      if (typeof code === "number") process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[remote-deploy] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSignalingEndpoint } from "./lib/connect-grammar.generated.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const SERVER_PACKAGE_NAME = "@panticonic/vibestudio-server";
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
      signalUrl: null,
      port: "3030",
      purge: false,
      help: true,
    };
  }
  const verb = ["status", "logs", "update", "remove"].includes(args[0]) ? args.shift() : "deploy";
  const options = {
    verb,
    target: args.shift() ?? null,
    artifact: null,
    signalUrl: null,
    port: "3030",
    purge: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") options.artifact = path.resolve(args[++i] ?? "");
    else if (arg === "--signal-url") {
      const raw = args[++i];
      if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
        throw new Error(`${arg} requires one signaling URL without control characters`);
      }
      const parsed = parseSignalingEndpoint(raw);
      if (parsed.kind === "error") throw new Error(parsed.reason);
      const url = new URL(parsed.url);
      if (url.username || url.password)
        throw new Error("Signaling URL must not contain credentials");
      options.signalUrl = parsed.url;
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
  return options;
}

export function printHelp() {
  console.log(`vibestudio remote deploy

Usage:
  vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <wss-url>] [--port 3030]
  vibestudio remote deploy status <user@host>
  vibestudio remote deploy logs <user@host>
  vibestudio remote deploy update <user@host> [--artifact <tgz>] [--signal-url <wss-url>] [--port 3030]
  vibestudio remote deploy remove <user@host> [--purge]

Deploys a systemd user unit named vibestudio-server. With --artifact, the
tarball is copied to the host and installed with npm install -g. Without
--artifact, the remote host installs the invoking CLI package/version with npm.
The remote host must run Node.js ${pkg.engines.node}.
Remove leaves workspace source intact. --purge also removes the installed npm
package and WebRTC identity material, so every paired device must re-pair.
`);
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
  const signalEnv = options.signalUrl
    ? `Environment=${systemdQuote(`VIBESTUDIO_WEBRTC_SIGNAL_URL=${options.signalUrl}`)}\n`
    : "";
  const requiredNodeTuple = JSON.stringify(REQUIRED_NODE_VERSION);
  console.log(`✓ SSH connection            ${options.target}`);
  await ssh(
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
    const remoteArtifact = `/tmp/vibestudio-${Date.now()}.tgz`;
    await (hooks.run ?? run)("scp", [options.artifact, `${options.target}:${remoteArtifact}`]);
    await ssh(
      options.target,
      `set -e
npm install -g ${shellQuote(remoteArtifact)}
rm -f ${shellQuote(remoteArtifact)}
`,
      hooks
    );
    console.log(`✓ Installed artifact        ${path.basename(options.artifact)}`);
  } else {
    await ssh(
      options.target,
      `set -e
npm install -g ${shellQuote(`${SERVER_PACKAGE_NAME}@${pkg.version}`)}
`,
      hooks
    );
    console.log(`✓ Installed package         ${SERVER_PACKAGE_NAME}@${pkg.version}`);
  }
  const serverCommand = `__NODE_BIN__ __VIBESTUDIO_ENTRY__ remote serve --port ${options.port}`;
  const unit = `[Unit]
Description=Vibestudio remote server
After=network-online.target

[Service]
Type=simple
${signalEnv}ExecStart=${serverCommand}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  await ssh(
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
identity_path="$HOME/.config/vibestudio/workspaces/default/state/webrtc/identity.pem"
deadline=$((SECONDS + 120))
until "$node_bin" -e "fetch('http://127.0.0.1:${options.port}/healthz').then(r => r.json()).then(v => process.exit(v.ok && v.mode === 'hub' ? 0 : 1)).catch(() => process.exit(1))" && [ -s "$identity_path" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    journalctl --user -u vibestudio-server.service -n 100 --no-pager >&2
    echo "Timed out waiting for the hub and default workspace identity" >&2
    exit 1
  fi
  sleep 1
done
`,
    hooks
  );
  console.log("✓ systemd user service      vibestudio-server.service");
  const signalArg = options.signalUrl ? ` --signal-url ${shellQuote(options.signalUrl)}` : "";
  await ssh(
    options.target,
    `set -e
${RESOLVE_REMOTE_RUNTIME}
journalctl --user -u vibestudio-server.service -n 100 --no-pager
"$node_bin" "$vibestudio_entry" remote doctor${signalArg} --identity $HOME/.config/vibestudio/workspaces/default/state/webrtc/identity.pem
`,
    hooks
  );
}

function removeScript(purge) {
  const base = `systemctl --user disable --now vibestudio-server.service || true
rm -f $HOME/.config/systemd/user/vibestudio-server.service
systemctl --user daemon-reload`;
  if (!purge) return base;
  return `${base}
npm uninstall -g ${SERVER_PACKAGE_NAME} >/dev/null 2>&1 || true
find $HOME/.config/vibestudio/workspaces -maxdepth 4 -type d -path '*/state/webrtc' -exec rm -rf {} + 2>/dev/null || true
echo "Purged WebRTC identity material; every paired device must re-pair." >&2`;
}

export async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parseArgs([...argv]);
  if (options.help || !options.target) {
    printHelp();
    return options.help ? 0 : 1;
  }
  if (options.verb === "deploy" || options.verb === "update") return deploy(options, hooks);
  if (options.verb === "status")
    return ssh(
      options.target,
      "systemctl --user --no-pager status vibestudio-server.service",
      hooks
    );
  if (options.verb === "logs")
    return ssh(options.target, "journalctl --user -u vibestudio-server.service -f", hooks);
  if (options.verb === "remove") {
    return ssh(options.target, removeScript(options.purge), hooks);
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

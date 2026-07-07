#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

export function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help")) {
    return { verb: "deploy", target: null, artifact: null, signalUrl: null, port: "3030", workspace: null, help: true };
  }
  const verb = ["status", "logs", "update", "remove"].includes(args[0]) ? args.shift() : "deploy";
  const options = { verb, target: args.shift() ?? null, artifact: null, signalUrl: null, port: "3030", workspace: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") options.artifact = path.resolve(args[++i] ?? "");
    else if (arg === "--signal-url" || arg === "--signaling-url") options.signalUrl = args[++i] ?? "";
    else if (arg === "--port") options.port = args[++i] ?? "3030";
    else if (arg === "--workspace") options.workspace = args[++i] ?? "";
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function printHelp() {
  console.log(`vibestudio remote deploy

Usage:
  vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <wss-url>] [--port 3030] [--workspace default]
  vibestudio remote deploy status <user@host>
  vibestudio remote deploy logs <user@host>
  vibestudio remote deploy update <user@host> [--artifact <tgz>] [--signal-url <wss-url>] [--port 3030] [--workspace default]
  vibestudio remote deploy remove <user@host>

Deploys a systemd user unit named vibestudio-server. With --artifact, the
tarball is copied to the host and installed with npm install -g. Without
--artifact, the remote host installs the invoking CLI package/version with npm.
`);
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: process.env, stdio: options.stdio ?? "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`)));
  });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function workspaceNameForDeploy(options) {
  const name = options.workspace || "default";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("workspace name must contain only letters, numbers, hyphens, and underscores");
  }
  return name;
}

export async function ssh(target, script, hooks = {}) {
  await (hooks.run ?? run)("ssh", [target, "bash", "-lc", script]);
}

export async function deploy(options, hooks = {}) {
  if (!options.target) throw new Error("missing <user@host>");
  if (options.artifact && !fs.existsSync(options.artifact)) throw new Error(`artifact not found: ${options.artifact}`);
  const unitDir = "$HOME/.config/systemd/user";
  const signalEnv = options.signalUrl ? `Environment=VIBESTUDIO_WEBRTC_SIGNAL_URL=${options.signalUrl}\\n` : "";
  const bin = "vibestudio";
  const workspaceName = workspaceNameForDeploy(options);
  const serverCommand = `vibestudio remote serve --port ${shellQuote(options.port)}`;
  console.log(`✓ SSH connection            ${options.target}`);
  await ssh(options.target, `set -e
command -v node >/dev/null || { echo "Node.js 20+ is required on the remote host" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node.js 20+ is required, found " + process.version); process.exit(1); }'
if command -v systemctl >/dev/null; then
  systemctl --user --version >/dev/null
else
  echo "Unsupported init system: systemd user services are required" >&2
  exit 1
fi
mkdir -p ${unitDir} $HOME/.config/vibestudio/webrtc
if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
  if command -v sudo >/dev/null && sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1; then
    :
  else
    echo "linger setup requires privilege; run: sudo loginctl enable-linger $USER" >&2
    exit 42
  fi
fi
`, hooks);
  console.log("✓ Node.js                   remote runtime OK");
  if (options.artifact) {
    const remoteArtifact = `/tmp/vibestudio-${Date.now()}.tgz`;
    await (hooks.run ?? run)("scp", [options.artifact, `${options.target}:${remoteArtifact}`]);
    await ssh(options.target, `set -e
npm install -g ${shellQuote(remoteArtifact)}
rm -f ${shellQuote(remoteArtifact)}
`, hooks);
    console.log(`✓ Installed artifact        ${path.basename(options.artifact)}`);
  } else {
    await ssh(options.target, `set -e
npm install -g ${shellQuote(`@vibestudio/server@${pkg.version}`)}
`, hooks);
    console.log(`✓ Installed package         @vibestudio/server@${pkg.version}`);
  }
  const unit = `[Unit]
Description=Vibestudio remote server
After=network-online.target

[Service]
Type=simple
Environment=VIBESTUDIO_WEBRTC_IDENTITY=%h/.config/vibestudio/webrtc/identity.pem
${signalEnv}ExecStart=${serverCommand}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  await ssh(options.target, `set -e
cat > ${unitDir}/vibestudio-server.service <<'UNIT'
${unit}
UNIT
systemctl --user daemon-reload
systemctl --user enable --now vibestudio-server.service
systemctl --user is-active --quiet vibestudio-server.service
`, hooks);
  console.log("✓ systemd user service      vibestudio-server.service");
  const workspaceArg = options.workspace ? ` --workspace ${shellQuote(options.workspace)}` : "";
  const signalArg = options.signalUrl ? ` --signal-url ${shellQuote(options.signalUrl)}` : "";
  const childIdentity = `$HOME/.config/vibestudio/workspaces/${workspaceName}/state/webrtc/identity.pem`;
  await ssh(options.target, `set -e
${bin} remote invite --port ${shellQuote(options.port)}${workspaceArg}
${bin} remote doctor${signalArg} --identity ${shellQuote(childIdentity)}
`, hooks);
}

export async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parseArgs([...argv]);
  if (options.help || !options.target) {
    printHelp();
    return options.help ? 0 : 1;
  }
  if (options.verb === "deploy" || options.verb === "update") return deploy(options, hooks);
  if (options.verb === "status") return ssh(options.target, "systemctl --user --no-pager status vibestudio-server.service", hooks);
  if (options.verb === "logs") return ssh(options.target, "journalctl --user -u vibestudio-server.service -f", hooks);
  if (options.verb === "remove") {
    return ssh(options.target, "systemctl --user disable --now vibestudio-server.service || true; rm -f $HOME/.config/systemd/user/vibestudio-server.service; systemctl --user daemon-reload", hooks);
  }
  throw new Error(`unknown verb: ${options.verb}`);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`[remote-deploy] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

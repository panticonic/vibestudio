#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSignalingEndpoint } from "./lib/connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const SERVER_PACKAGE_NAME = "@panticonic/vibestudio-server";
const UNIT_NAME = "vibestudio-server.service";
// Generous fail-loud backstops. A healthy hub answers /healthz within a second
// or two; the child workspace identity is written shortly after the invite
// spawns the child. These are aborts for a genuinely stuck deploy, not tight
// races — never shorten them to "speed up" a slow-but-healthy host.
const HEALTHZ_READY_TIMEOUT_S = 60;
const CHILD_IDENTITY_TIMEOUT_S = 30;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help")) {
    return { verb: "deploy", target: null, artifact: null, signalUrl: null, port: "3030", workspace: null, purge: false, help: true };
  }
  const verb = ["status", "logs", "update", "remove"].includes(args[0]) ? args.shift() : "deploy";
  const options = { verb, target: args.shift() ?? null, artifact: null, signalUrl: null, port: "3030", workspace: null, purge: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") options.artifact = path.resolve(args[++i] ?? "");
    else if (arg === "--signal-url" || arg === "--signaling-url") options.signalUrl = args[++i] ?? "";
    else if (arg === "--port") options.port = args[++i] ?? "3030";
    else if (arg === "--workspace") options.workspace = args[++i] ?? "";
    else if (arg === "--purge") options.purge = true;
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
  vibestudio remote deploy remove <user@host> [--purge]

Deploys a systemd user unit named vibestudio-server. With --artifact, the
tarball is copied to the host and installed with npm install -g. Without
--artifact, the remote host installs the invoking CLI package/version with npm.

remove disables and deletes the unit. Add --purge to also uninstall the npm
package and delete the WebRTC identity material (every paired device must
re-pair). Workspace source directories are always left intact.
`);
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = typeof options.input === "string";
    const stdio = hasInput ? ["pipe", "inherit", "inherit"] : (options.stdio ?? "inherit");
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: process.env, stdio });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`))));
    if (hasInput) {
      child.stdin.on("error", () => {});
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function assertSafeTarget(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("missing <user@host>");
  }
  // A leading dash would be parsed by ssh as an option flag (e.g. -oProxyCommand=…),
  // so reject it outright rather than smuggle it into argv.
  if (target.startsWith("-")) {
    throw new Error(`refusing SSH target that looks like an option flag: ${target}`);
  }
  if (/\s/.test(target)) {
    throw new Error(`SSH target must not contain whitespace: ${target}`);
  }
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer from 1 to 65535 (got ${value})`);
  }
  return String(port);
}

export function validateSignalUrl(value) {
  if (!value) return null;
  const parsed = parseSignalingEndpoint(value);
  if (parsed.kind === "error") {
    throw new Error(`--signal-url is not a valid signaling endpoint: ${parsed.reason}`);
  }
  return parsed.url;
}

export function workspaceNameForDeploy(options) {
  const name = options.workspace || "default";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("workspace name must contain only letters, numbers, hyphens, and underscores");
  }
  return name;
}

// The script is fed to the remote `bash -l -s` over stdin as a SINGLE stream, so
// there is no ssh-side re-parse: `set -e` at the top aborts the whole script and
// a non-bash login shell can't mangle it. `-l` sources the user's login profile
// so nvm / user-prefix npm bin dirs land on PATH before we resolve `vibestudio`.
export async function ssh(target, script, hooks = {}) {
  assertSafeTarget(target);
  await (hooks.run ?? run)("ssh", [target, "bash", "-l", "-s"], { input: script });
}

function nodeHealthzProbe(port) {
  // Guaranteed available: preflight already asserts node >= 20. Exits 0 once the
  // loopback gateway answers /healthz with a non-5xx status.
  const probe =
    'const http=require("http");' +
    'http.get({host:"127.0.0.1",port:process.argv[1],path:"/healthz",timeout:2000},' +
    "(r)=>{r.resume();process.exit(r.statusCode&&r.statusCode<500?0:1);})" +
    '.on("error",()=>process.exit(1))' +
    '.on("timeout",function(){this.destroy();process.exit(1);});';
  return `node -e ${shellQuote(probe)} ${port}`;
}

export async function deploy(options, hooks = {}) {
  assertSafeTarget(options.target);
  if (options.artifact && !fs.existsSync(options.artifact)) throw new Error(`artifact not found: ${options.artifact}`);
  const port = validatePort(options.port);
  const signalUrl = validateSignalUrl(options.signalUrl);
  const workspaceName = workspaceNameForDeploy(options);
  const unitDir = "$HOME/.config/systemd/user";

  await ssh(
    options.target,
    `set -e
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
`,
    hooks
  );
  console.log(`✓ SSH connection            ${options.target}`);
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

  // The unit is written with a real newline before ExecStart (regression: a
  // literal "\n" collapsed ExecStart onto the Environment= line → "no ExecStart").
  // ExecStart uses the ABSOLUTE binary path resolved on the host (systemd's PATH
  // has no nvm / user-prefix npm bin dir, so a bare `vibestudio` crash-loops).
  const signalEnvLine = signalUrl
    ? `Environment="VIBESTUDIO_WEBRTC_SIGNAL_URL=${signalUrl}"\n`
    : "";
  await ssh(
    options.target,
    `set -e
VIBESTUDIO_BIN="$(command -v vibestudio || true)"
if [ -z "$VIBESTUDIO_BIN" ]; then
  echo "vibestudio binary not found on PATH after install; check the global npm bin dir (npm bin -g)" >&2
  exit 1
fi
cat > ${unitDir}/${UNIT_NAME} <<UNIT
[Unit]
Description=Vibestudio remote server
After=network-online.target

[Service]
Type=simple
Environment=VIBESTUDIO_WEBRTC_IDENTITY=%h/.config/vibestudio/webrtc/identity.pem
${signalEnvLine}ExecStart=\${VIBESTUDIO_BIN} remote serve --port ${port}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable vibestudio-server.service
# restart (not just enable --now) so an UPDATE replaces the running old binary.
systemctl --user restart vibestudio-server.service
systemctl --user is-active --quiet vibestudio-server.service
`,
    hooks
  );
  console.log(`✓ systemd user service      ${UNIT_NAME}`);

  const workspaceArg = options.workspace ? ` --workspace ${shellQuote(options.workspace)}` : "";
  const signalArg = signalUrl ? ` --signal-url ${shellQuote(signalUrl)}` : "";
  // The child workspace answerer writes its identity under the central config
  // dir (env-paths getWorkspacesDir → $HOME/.config/vibestudio/workspaces). Emit
  // it UNQUOTED-for-$HOME so the login shell expands it on the host (regression:
  // a single-quoted literal never expanded → doctor always failed).
  const childIdentity = `$HOME/.config/vibestudio/workspaces/${workspaceName}/state/webrtc/identity.pem`;
  await ssh(
    options.target,
    `set -e
VIBESTUDIO_BIN="$(command -v vibestudio || true)"
if [ -z "$VIBESTUDIO_BIN" ]; then echo "vibestudio binary not found on PATH" >&2; exit 1; fi
# is-active reflects fork, not readiness — poll /healthz so the invite below does
# not race a still-binding gateway (connection-refused on slower hosts).
ready=""
for i in $(seq 1 ${HEALTHZ_READY_TIMEOUT_S}); do
  if ${nodeHealthzProbe(port)}; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "vibestudio server did not answer http://127.0.0.1:${port}/healthz within ${HEALTHZ_READY_TIMEOUT_S}s" >&2
  echo "inspect logs with: vibestudio remote deploy logs <user@host>" >&2
  exit 1
fi
"$VIBESTUDIO_BIN" remote invite --port ${port}${workspaceArg}
CHILD_IDENTITY="${childIdentity}"
for i in $(seq 1 ${CHILD_IDENTITY_TIMEOUT_S}); do [ -f "$CHILD_IDENTITY" ] && break; sleep 1; done
"$VIBESTUDIO_BIN" remote doctor${signalArg} --identity "$CHILD_IDENTITY"
`,
    hooks
  );
}

function removeScript(purge) {
  const base = `systemctl --user disable --now ${UNIT_NAME} || true
rm -f $HOME/.config/systemd/user/${UNIT_NAME}
systemctl --user daemon-reload`;
  if (!purge) {
    return `${base}
echo "Removed the systemd unit. Left in place (use --purge to delete): the ${SERVER_PACKAGE_NAME} npm package, $HOME/.config/vibestudio/webrtc/identity.pem, and workspace directories under $HOME/.config/vibestudio/workspaces." >&2`;
  }
  return `${base}
npm uninstall -g ${SERVER_PACKAGE_NAME} >/dev/null 2>&1 || true
rm -rf $HOME/.config/vibestudio/webrtc
# Delete per-workspace WebRTC identities but keep workspace SOURCE (user projects).
find $HOME/.config/vibestudio/workspaces -maxdepth 4 -type d -path '*/state/webrtc' -exec rm -rf {} + 2>/dev/null || true
echo "Purged the npm package and WebRTC identity material. Every paired device must re-pair." >&2`;
}

export async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parseArgs([...argv]);
  if (options.help || !options.target) {
    printHelp();
    return options.help ? 0 : 1;
  }
  if (options.verb === "deploy" || options.verb === "update") return deploy(options, hooks);
  if (options.verb === "status") return ssh(options.target, `systemctl --user --no-pager status ${UNIT_NAME}`, hooks);
  if (options.verb === "logs") return ssh(options.target, `journalctl --user -u ${UNIT_NAME} -f`, hooks);
  if (options.verb === "remove") return ssh(options.target, removeScript(options.purge), hooks);
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

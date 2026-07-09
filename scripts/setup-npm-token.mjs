#!/usr/bin/env node
// Store the npm publish token used by scripts/publish-npm.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[setup-npm-token] ${message}`);
  process.exit(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tokenFile = npmTokenFilePath();

  if (options.help) {
    printUsage(tokenFile);
    return;
  }

  if (options.path) {
    console.log(tokenFile);
    return;
  }

  if (options.remove) {
    fs.rmSync(tokenFile, { force: true });
    console.log(`[setup-npm-token] Removed ${tokenFile}`);
    return;
  }

  const token = await readToken(options);
  if (!token) throw new Error("Token must not be empty.");

  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(tokenFile), 0o700);
  }
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(tokenFile, 0o600);
  }

  console.log(`[setup-npm-token] Saved npm publish token to ${tokenFile}`);
  console.log("[setup-npm-token] Next publish command: pnpm publish:npm");
}

function parseArgs(argv) {
  const options = { help: false, path: false, remove: false, stdin: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--path") {
      options.path = true;
    } else if (arg === "--remove") {
      options.remove = true;
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printUsage(tokenFile) {
  console.log(`Usage: pnpm setup:npm-token [-- options]

Save a granular npm access token for the release scripts.

Options:
  --stdin   Read the token from stdin instead of prompting
  --path    Print the token file path
  --remove  Delete the saved token
  --help    Show this help

Token file:
  ${tokenFile}

Create an npm granular token with package read/write access and bypass 2FA
enabled for the @panticonic scope, then run:

  pnpm setup:npm-token
  pnpm publish:npm
`);
}

async function readToken(options) {
  if (options.stdin) return parseToken(fs.readFileSync(0, "utf8"));

  const envToken = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  return promptHidden("NPM_TOKEN: ");
}

function parseToken(input) {
  const line =
    input
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith("#")) ?? "";
  const match = /^(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*=\s*(.*)$/.exec(line);
  const value = match ? match[1].trim() : line;
  return value.replace(/^['"]|['"]$/g, "");
}

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("No terminal available. Pipe the token with --stdin instead."));
      return;
    }

    const stdin = process.stdin;
    const previousRawMode = stdin.isRaw;
    let value = "";

    function cleanup() {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(previousRawMode);
      stdin.pause();
    }

    function finish() {
      process.stdout.write("\n");
      cleanup();
      resolve(value.trim());
    }

    function onData(chunk) {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003") {
          process.stdout.write("\n");
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function npmTokenFilePath() {
  if (process.env.VIBESTUDIO_NPM_TOKEN_FILE) {
    return path.resolve(expandHome(process.env.VIBESTUDIO_NPM_TOKEN_FILE));
  }
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(process.env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "vibestudio", "npm-publish-token");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

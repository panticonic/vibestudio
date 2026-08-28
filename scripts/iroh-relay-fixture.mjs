#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";

const VERSION = "1.0.2";
const TARGETS = Object.freeze({
  "arm64:linux": {
    target: "aarch64-unknown-linux-gnu",
    sha256: "5810cd3b0861640026deb4423a80d79af130242a34fe9b244d1bf4fd7fc1fdcd",
  },
  "x64:linux": {
    target: "x86_64-unknown-linux-gnu",
    sha256: "7faf12b2b0137b5993e8dd1fb7557b2e61fee1a53486db74bb80d5c96907af93",
  },
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureFixture() {
  const release = TARGETS[`${process.arch}:${process.platform}`];
  if (!release)
    throw new Error(`No pinned Iroh relay fixture for ${process.platform}/${process.arch}`);
  const root = path.join(
    process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache"),
    "vibestudio",
    "iroh-relay",
    VERSION,
    release.target
  );
  const archive = path.join(root, `iroh-relay-v${VERSION}-${release.target}.tar.gz`);
  const binary = path.join(root, "iroh-relay");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!existsSync(archive) || digest(await readFile(archive)) !== release.sha256) {
    const temporary = `${archive}.${process.pid}.tmp`;
    const url = `https://github.com/n0-computer/iroh/releases/download/v${VERSION}/iroh-relay-v${VERSION}-${release.target}.tar.gz`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body)
      throw new Error(`Iroh relay download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
    const actual = digest(await readFile(temporary));
    if (actual !== release.sha256) {
      throw new Error(
        `Iroh relay archive digest mismatch: expected ${release.sha256}, received ${actual}`
      );
    }
    await rename(temporary, archive);
  }
  if (!existsSync(binary)) {
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", root, "./iroh-relay"], {
      encoding: "utf8",
    });
    if (extracted.status !== 0)
      throw new Error(extracted.stderr || "Unable to extract Iroh relay fixture");
    await chmod(binary, 0o700);
  }
  return binary;
}

const binary = await ensureFixture();
if (process.argv.includes("--print-path")) {
  console.log(binary);
  process.exit(0);
}
const separator = process.argv.indexOf("--");
const args = separator >= 0 ? process.argv.slice(separator + 1) : ["--dev"];
const child = spawn(binary, args, { stdio: "inherit" });
const forwardSigint = () => child.kill("SIGINT");
const forwardSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", forwardSigint);
process.on("SIGTERM", forwardSigterm);
child.once("error", (error) => {
  console.error(`[iroh-relay-fixture] ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.off("SIGINT", forwardSigint);
  process.off("SIGTERM", forwardSigterm);
  process.exitCode = code ?? (signal ? 1 : 0);
});

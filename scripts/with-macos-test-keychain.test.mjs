import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./with-macos-test-keychain.sh", import.meta.url));
// These tests check the fixture's ownership and restoration protocol. Hosted
// macOS desktop acceptance exercises the real Security framework and encryption.
for (const failure of [null, "command", "add-generic-password"]) {
  test(`test keychain restores ownership after ${failure ?? "success"}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keychain-fixture-"));
    try {
      const bin = path.join(root, "bin");
      const temporary = path.join(root, "temporary");
      fs.mkdirSync(bin);
      fs.mkdirSync(temporary);
      const events = path.join(root, "events.jsonl");
      const electron = path.join(root, "Branded App.app", "Contents", "MacOS", "Electron");
      const shim = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (tool === 'uname') { process.stdout.write('Darwin\\n'); process.exit(0); }
if (tool === 'node') { process.stdout.write(process.env.FIXTURE_ELECTRON); process.exit(0); }
const safe = args.map((arg,i) => ['-p','-w'].includes(args[i-1]) ? '<redacted>' : arg);
fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(safe)+'\\n');
if (args[0] === process.env.FIXTURE_FAILURE) process.exit(9);
if (args[0] === 'default-keychain' && !args.includes('-s')) process.stdout.write('    "/old/login.keychain-db"\\n');
if (args[0] === 'list-keychains' && !args.includes('-s')) process.stdout.write('    "/old/login.keychain-db"\\n    "/old/extra.keychain-db"\\n');
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'synthetic');
if (args[0] === 'delete-keychain') fs.unlinkSync(args.at(-1));
`;
      for (const name of ["security", "uname", "node"])
        fs.writeFileSync(path.join(bin, name), shim, { mode: 0o700 });
      const result = spawnSync(
        "bash",
        [wrapper, process.execPath, "-e", `process.exit(${failure === "command" ? 7 : 0})`],
        {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            RUNNER_TEMP: temporary,
            FIXTURE_ELECTRON: electron,
            FIXTURE_EVENTS: events,
            FIXTURE_FAILURE: failure ?? "",
          },
          encoding: "utf8",
        }
      );
      assert.equal(result.status, failure === "command" ? 7 : failure ? 9 : 0, result.stderr);
      const calls = fs.readFileSync(events, "utf8").trim().split("\n").map(JSON.parse);
      const provision = calls.find((args) => args[0] === "add-generic-password");
      assert.equal(provision[provision.indexOf("-a") + 1], "Vibestudio");
      assert.equal(provision[provision.indexOf("-s") + 1], "Vibestudio Safe Storage");
      assert.equal(provision[provision.indexOf("-T") + 1], electron);
      assert.equal(provision.includes("-A"), false);
      assert.deepEqual(calls.at(-3), [
        "default-keychain",
        "-d",
        "user",
        "-s",
        "/old/login.keychain-db",
      ]);
      assert.deepEqual(calls.at(-2), [
        "list-keychains",
        "-d",
        "user",
        "-s",
        "/old/login.keychain-db",
        "/old/extra.keychain-db",
      ]);
      assert.equal(calls.at(-1)[0], "delete-keychain");
      assert.deepEqual(fs.readdirSync(temporary), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

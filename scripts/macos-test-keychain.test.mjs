import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMacosTestKeychain } from "./macos-test-keychain.mjs";

for (const fail of [null, "set-generic-password-partition-list", "bad-signature"]) {
  test(`private desktop keychain ownership: ${fail ?? "success"}`, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "desktop-keychain-test-"));
    const electronBinary = path.join(home, "Vibestudio.app", "Contents", "MacOS", "Electron");
    const calls = [];
    const hash = "1234567890abcdef1234567890abcdef12345678";
    const run = (command, args, env) => {
      assert.equal(env.HOME, home);
      calls.push([command, args]);
      if (args[0] === fail) throw new Error("synthetic setup failure");
      if (args[0] === "-d") return fail === "bad-signature" ? "" : `CDHash=${hash}\n`;
      return "";
    };
    try {
      if (fail) assert.throws(() => createMacosTestKeychain({ home, electronBinary }, run));
      else {
        const fixture = createMacosTestKeychain({ home, electronBinary }, run);
        assert.deepEqual(fixture.env, { HOME: home });
        fixture.dispose();
        fixture.dispose();
      }
      const keychain = path.join(home, "Library", "Keychains", "desktop-test.keychain-db");
      if (fail === "bad-signature") {
        assert.equal(
          calls.some(([tool]) => tool === "security"),
          false
        );
        return;
      }
      const item = calls.find(([, args]) => args[0] === "add-generic-password")[1];
      assert.equal(item[item.indexOf("-T") + 1], electronBinary);
      assert.equal(item.includes("-A"), false);
      const partition = calls.find(
        ([, args]) => args[0] === "set-generic-password-partition-list"
      )[1];
      assert.equal(partition[partition.indexOf("-S") + 1], `cdhash:${hash}`);
      for (const args of [item, partition]) {
        assert.equal(args[args.indexOf("-a") + 1], "Vibestudio");
        assert.equal(args[args.indexOf("-s") + 1], "Vibestudio Safe Storage");
        assert.equal(args.at(-1), keychain);
      }
      assert.deepEqual(calls.at(-1), ["security", ["delete-keychain", keychain]]);
      assert.equal(calls.filter(([, args]) => args[0] === "delete-keychain").length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

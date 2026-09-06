import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

function runTool(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000 });
  // Child errors can include argv containing synthetic encryption material.
  if (result.error || result.status !== 0)
    throw new Error(`macOS credential fixture ${path.basename(command)} ${args[0]} failed`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/** The private HOME is also Electron's HOME. Security stores its user default
 * and search list under HOME/Library/Preferences, not necessarily the login
 * account's directory (Apple DLDBListCFPref::getPwInfo). No runner defaults change.
 */
export function createMacosTestKeychain({ home, electronBinary }, run = runTool) {
  mkdirSync(path.join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home };
  const keychain = path.join(home, "Library", "Keychains", "desktop-test.keychain-db");
  const password = randomBytes(32).toString("hex");
  let created = false;
  const dispose = () => {
    if (!created) return;
    run("security", ["delete-keychain", keychain], env);
    created = false;
  };
  try {
    run("codesign", ["--verify", "--deep", "--strict", electronBinary], env);
    const signature = run("codesign", ["-d", "--verbose=4", electronBinary], env);
    const hash = /^CDHash=([a-f0-9]{40})$/im.exec(signature)?.[1];
    if (!hash) throw new Error("Verified desktop executable has no canonical CDHash");
    run("security", ["create-keychain", "-p", password, keychain], env);
    created = true;
    run("security", ["set-keychain-settings", "-lut", "21600", keychain], env);
    run("security", ["unlock-keychain", "-p", password, keychain], env);
    run("security", ["default-keychain", "-d", "user", "-s", keychain], env);
    run("security", ["list-keychains", "-d", "user", "-s", keychain], env);
    run(
      "security",
      [
        "add-generic-password",
        "-a",
        "Vibestudio",
        "-s",
        "Vibestudio Safe Storage",
        "-w",
        randomBytes(16).toString("base64"),
        "-T",
        electronBinary,
        keychain,
      ],
      env
    );
    // Apple's securityd assigns ad-hoc applications cdhash:<unique code hash>,
    // independently of the trusted-application ACL. Permit this exact app only.
    run(
      "security",
      [
        "set-generic-password-partition-list",
        "-a",
        "Vibestudio",
        "-s",
        "Vibestudio Safe Storage",
        "-S",
        `cdhash:${hash}`,
        "-k",
        password,
        keychain,
      ],
      env
    );
    return { env: { HOME: home }, electronArgs: [], dispose };
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "macOS credential fixture setup and retirement failed"
      );
    }
    throw error;
  }
}

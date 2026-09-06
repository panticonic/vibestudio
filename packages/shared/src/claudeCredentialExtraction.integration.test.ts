import { afterEach, expect, it } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { extractClaudeCredential } from "./claudeCredentialExtraction.js";

const appRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  // Match materializeClaudeLaunch's native realpath boundary. The JavaScript
  // realpathSync implementation preserves Windows component spelling while
  // promises.realpath/native resolve the filesystem's canonical spelling.
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "claude-credential-extraction-"))
  );
  roots.push(root);
  const staging = path.join(root, ".profile-stage");
  mkdirSync(staging);
  const metadata = lstatSync(staging, { bigint: true });
  renameSync(staging, path.join(root, "profile"));
  const profileDir = realpathSync.native(path.join(root, "profile"));
  return {
    root,
    profileDir,
    appRoot,
    profileIdentity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() },
  };
}

it("extracts bounded credential bytes using installed code inside MXC", async () => {
  const f = fixture();
  const directory = path.join(f.profileDir, "claude-config");
  mkdirSync(directory);
  const credential =
    '{"claudeAiOauth":{"accessToken":"synthetic","refreshToken":"synthetic-refresh","expiresAt":2000000000000,"scopes":[]}}';
  writeFileSync(path.join(directory, ".credentials.json"), credential);
  expect((await extractClaudeCredential(f)).toString()).toBe(credential);
  writeFileSync(path.join(directory, ".credentials.json"), "x".repeat(65537));
  await expect(extractClaudeCredential(f)).rejects.toThrow(
    "Confined Claude credential extraction failed"
  );
});

it("does not read an outside credential through a guest-authored directory link", async () => {
  const f = fixture();
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  const credential = path.join(outside, ".credentials.json");
  writeFileSync(credential, "outside-secret-canary");
  symlinkSync(
    outside,
    path.join(f.profileDir, "claude-config"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await expect(extractClaudeCredential(f)).rejects.toThrow(
    "Confined Claude credential extraction failed"
  );
  expect(readFileSync(credential, "utf8")).toBe("outside-secret-canary");
});

it("rejects a replaced profile anchor instead of admitting its new contents", async () => {
  const f = fixture();
  renameSync(f.profileDir, path.join(f.root, "original"));
  mkdirSync(f.profileDir);
  await expect(extractClaudeCredential(f)).rejects.toThrow("profile anchor was replaced");
});

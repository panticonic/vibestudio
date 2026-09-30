import { spawnSync as nodeSpawnSync } from "node:child_process";

/** A Developer ID identity is stable enough for non-interactive Keychain use. */
export function hasDeveloperIdSignature(
  executable: string,
  options: {
    platform?: NodeJS.Platform;
    spawnSync?: typeof nodeSpawnSync;
  } = {}
): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    const result = (options.spawnSync ?? nodeSpawnSync)(
      "codesign",
      ["--display", "--verbose=2", executable],
      { timeout: 5_000, encoding: "utf8" }
    );
    // codesign reports the certificate chain on stderr. Ad-hoc signatures
    // have no Authority row and must not be allowed to trigger Keychain UI.
    return result.status === 0 && /Authority=Developer ID Application:/u.test(result.stderr ?? "");
  } catch {
    return false;
  }
}

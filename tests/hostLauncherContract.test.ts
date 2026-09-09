import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Opt out only by stating why, in the file itself. */
const EXEMPTION = "host-launcher-contract: does not launch a host";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(mjs|cjs|ts)$/u.test(entry) && !/\.test\.[cm]?ts$|\.test\.mjs$/u.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A host refuses to start unless it is told which build generation it runs from.
 * That requirement arrived after every launcher already existed, and each one
 * that missed it started a server that could not start — in six places, found
 * one at a time as each was next run. Only two were exercised by CI; the rest
 * failed whoever reached for them next.
 *
 * So the requirement is checked rather than remembered.
 */
describe("host launcher contract", () => {
  const launchers = sourceFiles(path.join(repoRoot, "scripts"))
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      // Spawns something, and names a server entry to spawn.
      // Deliberately broad: a launcher that slips past this check is the whole
      // failure mode, while a file that only inspects artifacts can say so.
      if (text.includes(EXEMPTION)) return false;
      return (
        /\b(spawn|spawnSync|fork)\s*\(/u.test(text) &&
        /serverEntryArg\(\)|createServerInvocation\(|server-electron\.cjs/u.test(text)
      );
    })
    .map((file) => path.relative(repoRoot, file));

  it("finds the launchers it is meant to be checking", () => {
    // If this drops to nothing the detection has drifted and the rest is vacuous.
    expect(launchers.length).toBeGreaterThan(0);
  });

  it.each(launchers)("%s tells its host which build generation it runs", (relative) => {
    const text = readFileSync(path.join(repoRoot, relative), "utf8");
    expect(
      text.includes("VIBESTUDIO_HOST_ARTIFACT_ROOT"),
      `${relative} spawns a host without naming its build generation, which refuses to start. ` +
        "Derive it with hostArtifactRootForServerEntry from scripts/host-build-generations.mjs."
    ).toBe(true);
  });
});

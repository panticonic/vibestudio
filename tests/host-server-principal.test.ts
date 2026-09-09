import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The in-process `server` principal is the host's own control plane. It belongs
 * to no account and is a member of nothing, so it is authorized as a
 * host-originated caller — `createHostCaller` — and never as an ordinary
 * caller that happens to name itself "server".
 *
 * Hand-rolling one with `createVerifiedCaller(id, "server")` produces a caller
 * that satisfies no relationship requirement: the host's own internal lookups
 * then fail a workspace-membership check they can never pass, and the failure
 * surfaces far away as a missing panel, a missing credential, or an empty list.
 */
const HOST_SOURCE_ROOTS = ["src", "packages"];
const SERVER_CALLER = /createVerifiedCaller\(\s*[^,)]+,\s*"server"/;

function sourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-publish")
        return [];
      return sourceFiles(full);
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    if (entry.name.includes(".test.") || entry.name.includes("TestUtils")) return [];
    return [full];
  });
}

describe("in-process server principal", () => {
  it("is constructed only as a host caller in product code", () => {
    const root = path.resolve(__dirname, "..");
    const offenders = HOST_SOURCE_ROOTS.flatMap((dir) => sourceFiles(path.join(root, dir)))
      .filter((file) => SERVER_CALLER.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

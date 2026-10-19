import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Metro resolves `./x.js` to `x.native.ts` before `x.ts` (platform extensions),
// so a `.native.ts` entry that imports its own base name imports itself and
// silently exports nothing. Entries must import a differently named module.
const roots = [
  new URL(".", import.meta.url).pathname,
  new URL("../../rn-client-api/src/", import.meta.url).pathname,
];

describe("platform entries", () => {
  it("never import their own base name", () => {
    for (const root of roots) {
      for (const file of readdirSync(root).filter((name) => name.endsWith(".native.ts"))) {
        const base = file.replace(/\.native\.ts$/u, "");
        const source = readFileSync(join(root, file), "utf8");
        expect(source, `${root}${file}`).not.toMatch(
          new RegExp(
            `from\\s+["']\\./${base}(\\.js)?["']|import\\s+["']\\./${base}(\\.js)?["']`,
            "u"
          )
        );
      }
    }
  });
});

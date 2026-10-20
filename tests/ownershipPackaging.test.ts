import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_CLIENT_FILES,
  OWNERSHIP_REAPER_FILES,
} from "../packages/shared/src/ownershipFiles.mjs";
import {
  CJS_IMPORT_META_BANNER,
  CJS_IMPORT_META_DEFINE,
} from "../scripts/build-artifact-contracts.mjs";
import { copyOwnershipReaperAssets } from "../scripts/lib/ownership-reaper-assets.mjs";
import { stagePublishedPackage } from "../scripts/build-server-npm-package.mjs";

const runnable = process.platform !== "win32";

/** A process that opens an ownership, takes scratch from its reaper, and closes. */
const PROBE = `
  const ownership = await Ownership.open({ profileDir: process.argv[2], lifetime: "leased" });
  const scratch = await ownership.scratch("probe-");
  await ownership.close();
  console.log(JSON.stringify({ scratch }));
`;

function runProbe(args: string[]) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { scratch: string };
}

describe("ownership packaging", () => {
  it("ships the owner-side client and every file the reaper loads in the npm package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ownership-npm-"));
    try {
      // The CLI package vendors @vibestudio/shared by npm's publication list.
      const staged = path.join(root, "vendor/@vibestudio/shared");
      stagePublishedPackage(path.resolve("packages/shared"), staged);
      for (const filename of OWNERSHIP_CLIENT_FILES) {
        expect(fs.existsSync(path.join(staged, "src", filename)), filename).toBe(true);
      }
      if (!runnable) return;
      const profile = path.join(root, "profile");
      const probe = path.join(root, "probe.mjs");
      fs.writeFileSync(
        probe,
        `import { Ownership } from ${JSON.stringify(
          pathToFileURL(path.join(staged, "src/ownership.mjs")).href
        )};\n${PROBE}`
      );
      const { scratch } = runProbe([probe, profile]);
      expect(scratch.startsWith(path.join(profile, "ownership", "scratch"))).toBe(true);
      expect(fs.existsSync(scratch)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts the reaper from beside a CommonJS host bundle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ownership-bundle-"));
    try {
      const dist = path.join(root, "dist");
      fs.mkdirSync(dist);
      await build({
        stdin: {
          contents: `import { Ownership } from "./packages/shared/src/ownership.mjs";\n(async () => {${PROBE}})().catch((error) => { console.error(error); process.exit(1); });`,
          resolveDir: path.resolve("."),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: path.join(dist, "bundle.cjs"),
        define: { ...CJS_IMPORT_META_DEFINE },
        banner: { js: CJS_IMPORT_META_BANNER },
        logLevel: "silent",
      });
      copyOwnershipReaperAssets(dist);
      for (const filename of OWNERSHIP_REAPER_FILES) {
        expect(fs.existsSync(path.join(dist, filename)), filename).toBe(true);
      }
      if (!runnable) return;
      const profile = path.join(root, "profile");
      const { scratch } = runProbe([path.join(dist, "bundle.cjs"), profile]);
      expect(scratch.startsWith(path.join(profile, "ownership", "scratch"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("unpacks exactly the reaper files in the desktop package and none of the removed script modules", () => {
    const config = parse(fs.readFileSync(path.resolve("electron-builder.yml"), "utf8")) as {
      files: unknown[];
      asarUnpack: string[];
    };
    const unpackedReaper = config.asarUnpack
      .filter((pattern) => /^dist\/[^/*]+\.mjs$/u.test(pattern))
      .sort();
    expect(unpackedReaper).toEqual(OWNERSHIP_REAPER_FILES.map((name) => `dist/${name}`).sort());
    const text = JSON.stringify(config);
    expect(text).not.toContain("owned-process-tree");
    expect(text).not.toContain("owned-process-identity");
  });
});

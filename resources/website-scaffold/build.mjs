import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "docs");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// The build owns docs/. No source maps, secrets, environment files or extra static directories are copied.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: ["site.tsx"], outdir: output,
  bundle: true, platform: "browser", format: "esm", target: "es2022", jsx: "automatic", minify: true,
  sourcemap: false, metafile: true, conditions: ["browser", "import"],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (Object.values(result.metafile.outputs).some(file => file.imports.some(item => item.external)))
  throw new Error("Static output contains an external package import");
await writeFile(path.join(output, "index.html"), await readFile(path.join(root, "index.html")));
await writeFile(path.join(output, ".nojekyll"), "");
const inputs = ["App.tsx", "index.tsx", "site.tsx", "style.css", "index.html", "build.mjs", "package.json", "package-lock.json", "sdk.json", "tsconfig.json", "assets.d.ts"];
const source = Object.fromEntries(await Promise.all(inputs.sort().map(async file => [file, hash(await readFile(path.join(root, file)))])));
const files = Object.fromEntries(await Promise.all((await readdir(output)).sort().map(async file => [file, hash(await readFile(path.join(output, file)))])));
const manifest = { version: 1, sdk: JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8")), source, files };
await writeFile(path.join(output, "vibestudio-build.json"), JSON.stringify({ ...manifest, buildId: hash(JSON.stringify(manifest)) }, null, 2) + "\n");
console.log(`Built ${Object.keys(files).length + 1} public files in docs/`);

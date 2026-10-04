import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(packageRoot, "package.json"));
const dependencyRoot = dirname(require.resolve("svelte2tsx/package.json"));
const manifest = JSON.parse(await readFile(join(dependencyRoot, "package.json"), "utf8"));
const files = {};
for (const filename of ["svelte-shims-v4.d.ts", "svelte-jsx-v4.d.ts"]) {
  files[filename] = await readFile(join(dependencyRoot, filename), "utf8");
}
const environment = {
  source: {
    package: manifest.name,
    version: manifest.version,
    license: await readFile(join(dependencyRoot, "LICENSE"), "utf8"),
  },
  files,
};
const destination = join(packageRoot, "src/type-environment.generated.json");
const encoded = `${JSON.stringify(environment, null, 2)}\n`;
let previous;
try { previous = await readFile(destination, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (process.argv.includes("--check")) {
  if (previous !== encoded) throw new Error("Svelte type environment differs from its installed compiler dependency; regenerate it");
} else if (previous !== encoded) {
  await writeFile(destination, encoded);
}

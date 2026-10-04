import { constants, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertPhononRuntimeArtifacts } from "../../scripts/phonon-runtime-artifacts.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Packaging tests use the same pinned speech resources as the production build. */
export async function copyPhononRuntime(root: string) {
  await assertPhononRuntimeArtifacts(repositoryRoot);
  cpSync(path.join(repositoryRoot, "dist/phonon"), path.join(root, "dist/phonon"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

export async function preparePhononPackaging(root: string) {
  await copyPhononRuntime(root);
  const require = createRequire(path.join(repositoryRoot, "package.json"));
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  for (const name of ["koffi", "fft.js"]) {
    let directory = path.dirname(require.resolve(name));
    while (
      !existsSync(path.join(directory, "package.json")) ||
      JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name !== name
    ) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate ${name} fixture dependency`);
      directory = parent;
    }
    symlinkSync(directory, path.join(root, "node_modules", name), "junction");
  }
  return { extraResources: [{ from: "dist/phonon", filter: [] as string[] }] };
}

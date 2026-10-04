import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles compiler declarations and helpers into an artifact with no installed dependency tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "svelte-type-artifact-"));
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(root, "compiler.mjs"),
      // Native jobs provide these CommonJS globals for bundled dependencies.
      banner: { js: 'import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; import { dirname } from "node:path"; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);' },
    });
    await writeFile(join(root, "probe.mjs"), `
      import {compileSvelteTypeSource, projectSvelteDeclarations, svelteTypeEnvironment} from './compiler.mjs';
      const compiled = compileSvelteTypeSource('<script lang="ts">let name: string = "world";</script><h1>{name}</h1>', 'Fixture.svelte');
      const declarations = projectSvelteDeclarations('declare module "*.svelte" {const x: string;}\\ndeclare const kept: number;', 'fixture.d.ts');
      if (!compiled.isTypeScript || !compiled.code.includes('name')) throw new Error('Compiler helper failed');
      if (declarations.includes('*.svelte') || !declarations.includes('kept')) throw new Error('Declaration projection failed');
      for (const text of Object.values(svelteTypeEnvironment)) if (!text.includes('svelte')) throw new Error('Compiler declaration missing');
      console.log(JSON.stringify({declarations: Object.keys(svelteTypeEnvironment), compiled: true}));
    `);
    const result = await promisify(execFile)(process.execPath, [join(root, "probe.mjs")], { cwd: root });
    expect(JSON.parse(result.stdout)).toEqual({ declarations: ["svelte-shims-v4.d.ts", "svelte-jsx-v4.d.ts"], compiled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

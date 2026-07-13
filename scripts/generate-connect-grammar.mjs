import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPoint = path.join(repoRoot, "packages/shared/src/connect.ts");
const outputPath = path.join(repoRoot, "scripts/cli/lib/connect-grammar.generated.mjs");
const generatedHeader =
  "// Generated from packages/shared/src/connect.ts by scripts/generate-connect-grammar.mjs.\n" +
  "// Do not edit this dependency-free raw-node artifact by hand.\n";

async function generatedSource() {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild did not produce the connect grammar artifact");
  return generatedHeader + output.text;
}

export async function generateConnectGrammar({ check = false } = {}) {
  const next = await generatedSource();
  if (check) {
    const current = await fs.readFile(outputPath, "utf8").catch(() => "");
    if (current !== next) {
      throw new Error(
        "scripts/cli/lib/connect-grammar.generated.mjs is stale; run `node scripts/generate-connect-grammar.mjs`"
      );
    }
    return;
  }
  await fs.writeFile(outputPath, next, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateConnectGrammar({ check: process.argv.includes("--check") });
}

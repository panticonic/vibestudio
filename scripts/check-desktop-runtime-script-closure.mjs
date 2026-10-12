import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { includeDesktopRuntimeScriptClosure } from "./lib/npm-runtime-script-closure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = parse(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
const closure = includeDesktopRuntimeScriptClosure(root, config);
process.stdout.write(`Desktop runtime script closure verified (${closure.files.length} files).\n`);

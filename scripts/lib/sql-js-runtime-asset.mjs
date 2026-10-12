import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// sql.js resolves its default WASM payload beside the executing bundle. Both
// server artifacts bundle the JavaScript loader into dist/, so stage the
// matching runtime there as part of each complete host build.
export function copySqlJsRuntimeAsset(distDirectory) {
  fs.copyFileSync(
    require.resolve("sql.js/dist/sql-wasm.wasm"),
    path.join(distDirectory, "sql-wasm.wasm")
  );
}

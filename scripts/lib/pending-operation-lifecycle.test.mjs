import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const helperPath = fileURLToPath(new URL("./pending-operation-lifecycle.mjs", import.meta.url));

test("a pending promise cannot let the CLI exit successfully after the event loop drains", () => {
  const source = `import { failIfOperationOutlivesEventLoop } from ${JSON.stringify(
    pathToFileURL(helperPath).href
  )};\nfailIfOperationOutlivesEventLoop(new Promise(() => {}), "owned packaging");\n`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: path.dirname(helperPath),
    encoding: "utf8",
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /owned packaging remained pending after Node had no active work/u);
});

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nodeRuntimeTarget, NODE_RUNTIME_VERSION } from "../../scripts/node-runtime-artifacts.mjs";

/** Synthetic complete receipt for packaging orchestration tests, never execution. */
export function writeNodeRuntimeFixture(root: string, platform: string, arch: string) {
  const target = nodeRuntimeTarget(platform, arch);
  const destination = path.join(root, "dist/node", `${platform}-${arch}`);
  const executable = platform === "win32" ? "node.exe" : "bin/node";
  const files = {
    [executable]: Buffer.from("synthetic toolchain executable; this test only verifies staging"),
    "runtime.json": Buffer.from(
      JSON.stringify({ version: NODE_RUNTIME_VERSION, platform, arch }) + "\n"
    ),
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    writeFileSync(path.join(destination, name), bytes);
  }
  writeFileSync(
    path.join(destination, "vibestudio-runtime.json"),
    JSON.stringify({
      version: 1,
      nodeVersion: NODE_RUNTIME_VERSION,
      archive: target.archive,
      archiveSha256: target.sha256,
      files: Object.fromEntries(
        Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, bytes]) => [
            name,
            { sha256: createHash("sha256").update(bytes).digest("hex") },
          ])
      ),
    })
  );
}

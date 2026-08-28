import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectHostReuseRangeFindings } from "../scripts/check-userland-dependencies.mjs";

describe("collectHostReuseRangeFindings", () => {
  it("requires the published Host range to fit entirely inside Base's runtime range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "panels", "demo"), { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { zod: "^3.24.1", react: "19.0.0" } })
      );
      fs.writeFileSync(
        path.join(base, "panels", "demo", "package.json"),
        JSON.stringify({ dependencies: { zod: "^3.25.76", react: "^19.0.0" } })
      );

      expect(collectHostReuseRangeFindings(host, base)).toEqual([
        {
          relative: "panels/demo/package.json",
          section: "dependencies",
          name: "zod",
          specifier: "^3.25.76",
          hostSpecifier: "^3.24.1",
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes dependencies whose exact bytes are owned by a Base patch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "packages", "patched"), { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { "@scope/tool": "^1.0.0" } })
      );
      fs.writeFileSync(
        path.join(base, "packages", "patched", "package.json"),
        JSON.stringify({
          dependencies: { "@scope/tool": "1.2.3" },
          vibestudio: {
            dependencyResolution: {
              patches: { "@scope/tool@1.2.3": { path: "patch.diff", roots: ["@scope/tool"] } },
            },
          },
        })
      );

      expect(collectHostReuseRangeFindings(host, base)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

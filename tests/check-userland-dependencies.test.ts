import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectHostReuseRangeFindings,
  collectStartupHostReuseFindings,
} from "../scripts/check-userland-dependencies.mjs";

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

describe("collectStartupHostReuseFindings", () => {
  it("requires every canonical startup dependency to be directly published by Host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-startup-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "meta"), { recursive: true });
      fs.mkdirSync(path.join(base, "apps", "shell"), { recursive: true });
      fs.mkdirSync(path.join(base, "panels", "chat"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "meta", "vibestudio.yml"),
        [
          "hostTargets:",
          "  electron:",
          "    app: apps/shell",
          "initPanels:",
          "  - source: panels/chat",
          "",
        ].join("\n")
      );
      fs.writeFileSync(
        path.join(base, "apps", "shell", "package.json"),
        JSON.stringify({ name: "@workspace-apps/shell", dependencies: { react: "^19.0.0" } })
      );
      fs.writeFileSync(
        path.join(base, "panels", "chat", "package.json"),
        JSON.stringify({ name: "@workspace-panels/chat", dependencies: { zod: "^3.25.76" } })
      );
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { react: "^19.0.0" } })
      );

      await expect(collectStartupHostReuseFindings(host, base)).resolves.toEqual([
        {
          unitPath: "panels/chat",
          missing: ["zod@^3.25.76"],
          incompatible: [],
          policies: [],
        },
      ]);

      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { react: "^19.0.0", zod: "^3.25.76" } })
      );
      await expect(collectStartupHostReuseFindings(host, base)).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

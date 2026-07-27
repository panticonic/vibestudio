import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeDevelopmentController } from "./nativeDevelopmentComposition.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("native development production composition", () => {
  it.skipIf(process.platform !== "linux")(
    "selects the real local Claude driver and keeps system-editor typed unavailable before VCS work",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-composition-"));
      roots.push(root);
      const cli = path.join(root, "claude");
      await fs.writeFile(
        cli,
        '#!/usr/bin/env node\nif (process.argv.includes("--version")) process.stdout.write("2.1.81\\n");\nelse setInterval(() => {}, 1000);\n',
        { mode: 0o700 }
      );
      const planSource = vi.fn();
      const materializeSource = vi.fn();
      const controller = await createNativeDevelopmentController({
        executorId: "executor:test",
        root: path.join(root, "sessions"),
        blobsDir: path.join(root, "blobs"),
        semantic: {
          commitChildBase: vi.fn(),
          importSnapshot: vi.fn(),
        },
        planSource,
        materializeSource,
        claudeCandidatePaths: [cli],
      });

      await expect(controller.describeTool("claude-code")).resolves.toMatchObject({
        available: true,
        interactiveTerminal: true,
      });
      await expect(controller.describeTool("system-editor")).resolves.toEqual({
        toolId: "system-editor",
        executorId: "executor:test",
        available: false,
        unavailableReason: "checkpoint-protocol-unavailable",
        interactiveTerminal: false,
      });
      expect(planSource).not.toHaveBeenCalled();
      expect(materializeSource).not.toHaveBeenCalled();
    }
  );
});

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
    "keeps system-editor typed unavailable before VCS work",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-composition-"));
      roots.push(root);
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

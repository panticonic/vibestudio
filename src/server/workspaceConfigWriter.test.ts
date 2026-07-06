import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createRefService } from "./services/refService.js";
import {
  collectTreeReachableDigests,
  ensureLayout,
  getBytes,
  listTree,
  mirrorWorktreeTree,
  putBytes,
  readFileAtTree,
} from "./services/blobstoreService.js";
import { createWorkspaceConfigMainWriter } from "./workspaceConfigWriter.js";

const FILE_MODE = 33188;

describe("workspaceConfigWriter", () => {
  it("persists workspace config through protected meta/main and preserves protected YAML fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-config-writer-"));
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
      assertTreeComplete: async (stateHash) => {
        if (!(await collectTreeReachableDigests(blobsDir, stateHash))) {
          throw new Error(`incomplete tree: ${stateHash}`);
        }
      },
    });
    const protectedContent = YAML.stringify({
      id: "test",
      unknownTopLevel: { keep: true },
      git: {
        remotes: {
          projects: {
            old: {
              origin: "https://example.com/old.git",
            },
          },
        },
      },
    });
    const staleProjectedContent = YAML.stringify({ id: "test", unknownTopLevel: "stale" });
    const protectedDigest = (await putBytes(blobsDir, Buffer.from(protectedContent, "utf8")))
      .digest;
    const staleDigest = (await putBytes(blobsDir, Buffer.from(staleProjectedContent, "utf8")))
      .digest;
    const protectedState = (
      await mirrorWorktreeTree(blobsDir, [
        { path: "vibestudio.yml", contentHash: protectedDigest, mode: FILE_MODE },
      ])
    ).stateHash;
    const staleState = (
      await mirrorWorktreeTree(blobsDir, [
        { path: "vibestudio.yml", contentHash: staleDigest, mode: FILE_MODE },
      ])
    ).stateHash;
    await refs.seedMain({ repoPath: "meta", value: protectedState });

    const writer = createWorkspaceConfigMainWriter({
      workspacePath: path.join(root, "source"),
      blobsDir,
      refs,
      vcs: {
        async readFile(ref, filePath) {
          const meta = await readFileAtTree(blobsDir, ref, filePath);
          if (!meta) return null;
          const bytes = await getBytes(blobsDir, meta.contentHash);
          if (!bytes) throw new Error("missing test blob");
          return { content: { kind: "text" as const, text: bytes.toString("utf8") } };
        },
        async listFiles(ref) {
          const entries = await listTree(blobsDir, ref);
          return (entries ?? [])
            .filter((entry) => entry.kind === "file")
            .map((entry) => ({
              path: entry.path,
              contentHash: entry.contentHash,
              mode: entry.mode,
            }));
        },
      },
    });

    const changed = await writer.persist({
      ctx: { caller: createVerifiedCaller("server", "server") },
      nextConfig: {
        id: "test",
        git: {
          remotes: {
            projects: {
              bgkit: {
                origin: "https://github.com/werg/bgkit.git",
              },
            },
          },
        },
      },
      summary: "record bgkit remote",
      operation: "push",
    });

    expect(changed).toBe(true);
    const updated = refs.readMain("meta");
    expect(updated?.stateHash).not.toBe(protectedState);
    expect(updated?.stateHash).not.toBe(staleState);
    const updatedFile = await readFileAtTree(blobsDir, updated!.stateHash, "vibestudio.yml");
    const updatedBytes = await getBytes(blobsDir, updatedFile!.contentHash);
    const parsed = YAML.parse(updatedBytes!.toString("utf8")) as Record<string, unknown>;
    expect(parsed["unknownTopLevel"]).toEqual({ keep: true });
    expect(parsed["git"]).toEqual({
      remotes: {
        projects: {
          bgkit: {
            origin: "https://github.com/werg/bgkit.git",
          },
        },
      },
    });
  });
});

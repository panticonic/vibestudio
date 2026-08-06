import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import { type DevTemplateTreeFile, mirrorDevTemplatePublication } from "./devTemplateMirror.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const file = (filePath: string, content: string): DevTemplateTreeFile => ({
  path: filePath,
  contentHash: digest(content),
  executable: false,
});

describe("mirrorDevTemplatePublication", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup() {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-dev-template-mirror-"));
    const blobs = new Map<string, Buffer>();
    const states = new Map<string, DevTemplateTreeFile[]>();
    const publication = (repositories: ProtectedPublicationEvent["repositories"]) =>
      ({
        publicationId: "publication:test",
        resultHostRefsBasisDigest: "basis:test",
        appliedAt: 1,
        workspaceStateHash: "state:workspace",
        changedPaths: repositories.flatMap((entry) => entry.fileChanges.map((item) => item.path)),
        repositories,
      }) satisfies ProtectedPublicationEvent;
    const repository = (
      previousStateHash: string,
      nextStateHash: string
    ): ProtectedPublicationEvent["repositories"][number] => ({
      repoPath: "packages/pushed",
      previousStateHash,
      nextStateHash,
      fileChanges: [],
    });
    return { blobs, states, publication, repository };
  }

  it("merges app-only and checkout-only changes without touching unpushed units", async () => {
    const { blobs, states, publication, repository } = await setup();
    await fsp.mkdir(path.join(root!, "packages", "pushed"), { recursive: true });
    await fsp.mkdir(path.join(root!, "packages", "unpushed"), { recursive: true });
    await fsp.writeFile(path.join(root!, "packages/pushed/index.ts"), "before\n");
    await fsp.writeFile(path.join(root!, "packages/pushed/local.ts"), "local edit\n");
    await fsp.writeFile(path.join(root!, "packages/unpushed/index.ts"), "unpushed edit\n");
    blobs.set(digest("after\n"), Buffer.from("after\n"));
    states.set("state:before", [file("index.ts", "before\n")]);
    states.set("state:after", [file("index.ts", "after\n")]);

    const result = await mirrorDevTemplatePublication({
      destinationRoot: root!,
      publication: publication([repository("state:before", "state:after")]),
      inspectRepository: async () => ({
        files: [file("index.ts", "before\n"), file("local.ts", "local edit\n")],
        skippedPaths: [],
      }),
      readState: async (stateHash) => states.get(stateHash) ?? [],
      readBlob: async (hash) => blobs.get(hash) ?? null,
    });

    expect(result).toEqual({
      appliedRepositories: ["packages/pushed"],
      changedPathCount: 1,
      conflicts: [],
    });
    expect(await fsp.readFile(path.join(root!, "packages/pushed/index.ts"), "utf8")).toBe(
      "after\n"
    );
    expect(await fsp.readFile(path.join(root!, "packages/pushed/local.ts"), "utf8")).toBe(
      "local edit\n"
    );
    expect(await fsp.readFile(path.join(root!, "packages/unpushed/index.ts"), "utf8")).toBe(
      "unpushed edit\n"
    );
  });

  it("rejects an overlapping edit without applying any part of the publication", async () => {
    const { blobs, states, publication, repository } = await setup();
    await fsp.mkdir(path.join(root!, "packages", "pushed"), { recursive: true });
    await fsp.writeFile(path.join(root!, "packages/pushed/index.ts"), "concurrent edit\n");
    blobs.set(digest("after\n"), Buffer.from("after\n"));
    states.set("state:before", [file("index.ts", "before\n")]);
    states.set("state:after", [file("index.ts", "after\n")]);

    const result = await mirrorDevTemplatePublication({
      destinationRoot: root!,
      publication: publication([repository("state:before", "state:after")]),
      inspectRepository: async () => ({
        files: [file("index.ts", "concurrent edit\n")],
        skippedPaths: [],
      }),
      readState: async (stateHash) => states.get(stateHash) ?? [],
      readBlob: async (hash) => blobs.get(hash) ?? null,
    });

    expect(result.appliedRepositories).toEqual([]);
    expect(result.conflicts).toEqual([
      { repoPath: "packages/pushed", paths: ["index.ts"], skippedPaths: [] },
    ]);
    expect(await fsp.readFile(path.join(root!, "packages/pushed/index.ts"), "utf8")).toBe(
      "concurrent edit\n"
    );
  });

  it("rejects a file/directory collision created by independent changes", async () => {
    const { blobs, states, publication, repository } = await setup();
    await fsp.mkdir(path.join(root!, "packages/pushed/foo"), { recursive: true });
    await fsp.writeFile(path.join(root!, "packages/pushed/foo/base.ts"), "base\n");
    await fsp.writeFile(path.join(root!, "packages/pushed/foo/local.ts"), "local\n");
    blobs.set(digest("next\n"), Buffer.from("next\n"));
    states.set("state:before", [file("foo/base.ts", "base\n")]);
    states.set("state:after", [file("foo", "next\n")]);

    const result = await mirrorDevTemplatePublication({
      destinationRoot: root!,
      publication: publication([repository("state:before", "state:after")]),
      inspectRepository: async () => ({
        files: [file("foo/base.ts", "base\n"), file("foo/local.ts", "local\n")],
        skippedPaths: [],
      }),
      readState: async (stateHash) => states.get(stateHash) ?? [],
      readBlob: async (hash) => blobs.get(hash) ?? null,
    });

    expect(result.appliedRepositories).toEqual([]);
    expect(result.conflicts[0]?.paths).toEqual(["foo", "foo/local.ts"]);
    expect(await fsp.readFile(path.join(root!, "packages/pushed/foo/local.ts"), "utf8")).toBe(
      "local\n"
    );
  });

  it("rechecks changed files after the three-way inspection", async () => {
    const { blobs, states, publication, repository } = await setup();
    await fsp.mkdir(path.join(root!, "packages", "pushed"), { recursive: true });
    await fsp.writeFile(path.join(root!, "packages/pushed/index.ts"), "late edit\n");
    blobs.set(digest("after\n"), Buffer.from("after\n"));
    states.set("state:before", [file("index.ts", "before\n")]);
    states.set("state:after", [file("index.ts", "after\n")]);

    await expect(
      mirrorDevTemplatePublication({
        destinationRoot: root!,
        publication: publication([repository("state:before", "state:after")]),
        inspectRepository: async () => ({
          files: [file("index.ts", "before\n")],
          skippedPaths: [],
        }),
        readState: async (stateHash) => states.get(stateHash) ?? [],
        readBlob: async (hash) => blobs.get(hash) ?? null,
      })
    ).rejects.toThrow("destination changed while mirroring");
    expect(await fsp.readFile(path.join(root!, "packages/pushed/index.ts"), "utf8")).toBe(
      "late edit\n"
    );
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";

import { GitClient } from "@vibestudio/git";
import { sha256Hex } from "@vibestudio/content-addressing";
import { seedRootTemplateSnapshotFromCheckout } from "../server/acquireRootTemplateSnapshot.js";

const roots: string[] = [];

function git(directory: string, ...args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Vibestudio Test",
      GIT_AUTHOR_EMAIL: "test@vibestudio.invalid",
      GIT_COMMITTER_NAME: "Vibestudio Test",
      GIT_COMMITTER_EMAIL: "test@vibestudio.invalid",
    },
  });
}

function fixture(): { checkout: string; checkpointRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-selection-"));
  roots.push(root);
  const checkout = path.join(root, "template");
  fs.mkdirSync(path.join(checkout, "meta"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "panels", "example"), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, "meta", "vibestudio.yml"),
    [
      "systemEpoch: 0",
      "template:",
      "  name: Example",
      "  description: Example template.",
      "  repositories:",
      "    - panels/example",
      "  files: []",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(checkout, "panels", "example", "index.ts"), "export const v = 1;\n");
  git(checkout, "init", "-b", "main");
  git(checkout, "remote", "add", "origin", "git@github.com:acme/example.git");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "fixture");
  return { checkout, checkpointRoot: path.join(root, "checkpoints") };
}

let previousSharedCache: string | undefined;

// Template checkouts are profile-level derived data, so a test has to say
// where that profile is or it writes into the developer's own.
beforeEach(() => {
  previousSharedCache = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
  const derived = fs.mkdtempSync(path.join(os.tmpdir(), "template-selection-derived-"));
  roots.push(derived);
  process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = derived;
});

afterEach(() => {
  if (previousSharedCache === undefined) delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
  else process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedCache;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("development template selection", () => {
  it("checkpoints dirty source and derives canonical identity from an SSH origin", async () => {
    const fx = fixture();
    fs.writeFileSync(
      path.join(fx.checkout, "panels", "example", "new.ts"),
      "export const v = 2;\n"
    );

    const [selection] = await inspectWorkspaceSources({
      checkouts: [fx.checkout],
      checkpointRoot: fx.checkpointRoot,
    });

    expect(selection).toMatchObject({
      sourceCheckout: fx.checkout,
      changedPaths: ["panels/example/new.ts"],
      review: {
        presentation: { name: "Example", description: "Example template." },
        repositories: ["panels/example"],
        files: [],
      },
      pin: {
        url: "git+https://github.com/acme/example.git",
        ref: "refs/heads/vibestudio-dev-checkpoint",
      },
    });
    expect(
      fs.readFileSync(path.join(selection!.checkout, "panels", "example", "new.ts"), "utf8")
    ).toContain("v = 2");
  });

  it("creates the reviewed snapshot from private checkout bytes even after the source changes", async () => {
    const fx = fixture();
    const source = path.join(fx.checkout, "panels/example/index.ts");
    fs.writeFileSync(source, "export const v = 'reviewed local state';\n");
    const [selection] = await inspectWorkspaceSources({
      checkouts: [fx.checkout],
      checkpointRoot: fx.checkpointRoot,
    });
    fs.writeFileSync(source, "export const v = 'later edit';\n");
    const snapshot = await seedRootTemplateSnapshotFromCheckout({
      checkout: selection!.checkout,
      pin: selection!.pin,
      git: new GitClient(),
      sink: {
        async put(bytes) {
          return { digest: sha256Hex(bytes), size: bytes.byteLength };
        },
      },
    });
    expect(snapshot.commit).toBe(selection!.pin.commit);
    expect(new TextDecoder().decode(snapshot.readFile("panels/example/index.ts")!)).toContain(
      "reviewed local state"
    );
    expect(fs.readFileSync(source, "utf8")).toContain("later edit");
  });

  it("rejects old contribution layers instead of composing them into the developer workspace", async () => {
    const fx = fixture();
    fs.writeFileSync(
      path.join(fx.checkout, "meta", "vibestudio.yml"),
      fs
        .readFileSync(path.join(fx.checkout, "meta", "vibestudio.yml"), "utf8")
        .concat("templates:\n  use:\n    - url: git+https://github.com/acme/base.git\n")
    );
    git(fx.checkout, "add", ".");
    git(fx.checkout, "commit", "-m", "root");

    await expect(
      inspectWorkspaceSources({
        checkouts: [fx.checkout],
        checkpointRoot: fx.checkpointRoot,
      })
    ).rejects.toThrow(/unrecognized key.*templates/iu);
  });
});

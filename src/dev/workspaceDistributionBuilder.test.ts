import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { inspectRootTemplateCheckout } from "../server/acquireRootTemplateSnapshot.js";
import {
  buildWorkspaceDistribution,
  prepareDevelopmentWorkspaceDistributions,
} from "./workspaceDistributionBuilder.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function sourceFixture(): { root: string; output: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "distribution-builder-"));
  roots.push(parent);
  const root = path.join(parent, "source");
  const output = path.join(parent, "output");
  fs.mkdirSync(root);
  git(root, "init", "-b", "main");
  write(root, "package.json", '{"name":"@workspace/root","private":true}\n');
  write(
    root,
    "panels/chat/package.json",
    '{"name":"@workspace-panels/chat","dependencies":{"@workspace/runtime":"workspace:*"}}\n'
  );
  write(root, "panels/chat/index.ts", "export {};\n");
  write(root, "packages/runtime/package.json", '{"name":"@workspace/runtime"}\n');
  write(root, "packages/runtime/index.ts", "export {};\n");
  write(root, "packages/unrelated/package.json", '{"name":"@workspace/unrelated"}\n');
  write(root, "packages/unrelated/index.ts", "throw new Error('excluded');\n");
  write(
    root,
    "meta/distributions/personal.yml",
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
      "template:\n" +
      "  name: Personal\n" +
      "  repositories: [panels/chat]\n" +
      "  files: [package.json]\n" +
      "initPanels:\n" +
      "  - source: panels/chat\n"
  );
  for (const name of ["base", "system"]) {
    write(
      root,
      `meta/distributions/${name}.yml`,
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
        "template:\n" +
        `  name: ${name}\n` +
        "  repositories: [packages/runtime]\n" +
        "  files: [package.json]\n" +
        "providers:\n" +
        "  evalRuntime:\n" +
        "    source: '@workspace/runtime'\n"
    );
  }
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "source"
  );
  return { root, output };
}

describe("buildWorkspaceDistribution", () => {
  it("writes a separate exact root checkout from the positive repository closure", async () => {
    const fixture = sourceFixture();
    const url = "git+https://example.test/personal.git";
    const built = await buildWorkspaceDistribution({
      sourceRoot: fixture.root,
      manifestPath: "meta/distributions/personal.yml",
      outputRoot: fixture.output,
      url,
      ref: "refs/heads/distributions/personal",
    });

    expect(built.repositories).toEqual(["packages/runtime", "panels/chat"]);
    expect(fs.existsSync(path.join(fixture.output, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, "packages/runtime/index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, "packages/unrelated"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.output, "meta/distributions"))).toBe(false);
    expect(git(fixture.output, "remote", "get-url", "origin")).toBe(
      "https://example.test/personal.git"
    );
    expect(git(fixture.output, "branch", "--show-current")).toBe("distributions/personal");

    const inspected = await inspectRootTemplateCheckout({
      checkout: fixture.output,
      url,
      git: new GitClient(),
      sink: {
        async put(bytes) {
          return { digest: sha256Hex(bytes), size: bytes.byteLength };
        },
      },
    });
    expect(inspected.pin).toEqual(built.pin);
  });

  it("does not create output when dependency closure validation fails", async () => {
    const fixture = sourceFixture();
    fs.writeFileSync(
      path.join(fixture.root, "panels/chat/package.json"),
      '{"name":"@workspace-panels/chat","dependencies":{"@workspace/missing":"workspace:*"}}\n'
    );

    await expect(
      buildWorkspaceDistribution({
        sourceRoot: fixture.root,
        manifestPath: "meta/distributions/personal.yml",
        outputRoot: fixture.output,
        url: "git+https://example.test/personal.git",
      })
    ).rejects.toThrow(/requires missing local dependency/u);
    expect(fs.existsSync(fixture.output)).toBe(false);
  });

  it("builds all development distributions at distinct exact coordinates of one URL", async () => {
    const fixture = sourceFixture();
    const url = "git+https://example.test/workspaces.git";
    const prepared = await prepareDevelopmentWorkspaceDistributions({
      sourceRoot: fixture.root,
      outputRoot: fixture.output,
      url,
    });

    expect(Object.keys(prepared.pins)).toEqual(["base", "personal", "system"]);
    expect(new Set(Object.values(prepared.pins).map((pin) => pin.url))).toEqual(new Set([url]));
    expect(new Set(Object.values(prepared.pins).map((pin) => pin.commit)).size).toBe(3);
    for (const name of ["base", "personal", "system"] as const) {
      expect(prepared.checkouts[name]).toBe(path.join(fixture.output, name));
      expect(git(prepared.checkouts[name], "branch", "--show-current")).toBe(
        `distributions/${name}`
      );
      expect(git(prepared.checkouts[name], "remote", "get-url", "origin")).toBe(
        "https://example.test/workspaces.git"
      );
    }
  });

  it("publishes no partial output when one distribution is invalid", async () => {
    const fixture = sourceFixture();
    write(
      fixture.root,
      "meta/distributions/system.yml",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
        "template:\n" +
        "  repositories: [packages/missing]\n" +
        "  files: [package.json]\n"
    );

    await expect(
      prepareDevelopmentWorkspaceDistributions({
        sourceRoot: fixture.root,
        outputRoot: fixture.output,
        url: "git+https://example.test/workspaces.git",
      })
    ).rejects.toThrow(/Distribution repository is missing/u);
    expect(fs.existsSync(fixture.output)).toBe(false);
  });
});

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
  write(root, "packages/test-runtime/package.json", '{"name":"@workspace/test-runtime"}\n');
  write(root, "packages/test-runtime/index.ts", "export {};\n");
  write(
    root,
    "skills/workspace-dev/package.json",
    '{"name":"@workspace-skills/workspace-dev","dependencies":{"@workspace/test-runtime":"workspace:*"}}\n'
  );
  write(root, "skills/workspace-dev/index.ts", "export {};\n");
  write(root, "packages/unrelated/package.json", '{"name":"@workspace/unrelated"}\n');
  write(root, "packages/unrelated/index.ts", "throw new Error('excluded');\n");
  write(
    root,
    "meta/distributions/personal.yml",
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
      "template:\n" +
      "  name: Personal\n" +
      "  repositories: [panels/chat, skills/workspace-dev]\n" +
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

    expect(built.repositories).toEqual([
      "packages/runtime",
      "packages/test-runtime",
      "panels/chat",
      "skills/workspace-dev",
    ]);
    expect(fs.existsSync(path.join(fixture.output, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, "packages/runtime/index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, "packages/test-runtime/index.ts"))).toBe(true);
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

  it("builds each development distribution at its own published address", async () => {
    const fixture = sourceFixture();
    const urls = {
      base: "git+https://example.test/base.git",
      personal: "git+https://example.test/personal.git",
      system: "git+https://example.test/system.git",
    };
    const prepared = await prepareDevelopmentWorkspaceDistributions({
      sourceRoot: fixture.root,
      outputRoot: fixture.output,
      urls,
    });

    expect(Object.keys(prepared.pins)).toEqual(["base", "personal", "system"]);
    // One repository each, so a distribution's URL identifies it outright.
    expect(Object.values(prepared.pins).map((pin) => pin.url)).toEqual([
      urls.base,
      urls.personal,
      urls.system,
    ]);
    expect(new Set(Object.values(prepared.pins).map((pin) => pin.commit)).size).toBe(3);
    for (const name of ["base", "personal", "system"] as const) {
      expect(prepared.checkouts[name]).toBe(path.join(fixture.output, name));
      // Each build stands in for a published template, and publication puts a
      // template on `main` of its own repository.
      expect(git(prepared.checkouts[name], "branch", "--show-current")).toBe("main");
      expect(git(prepared.checkouts[name], "remote", "get-url", "origin")).toBe(
        `https://example.test/${name}.git`
      );
    }
  });

  const URLS = {
    base: "git+https://example.test/base.git",
    personal: "git+https://example.test/personal.git",
    system: "git+https://example.test/system.git",
  };

  /** Rewrite one fixture manifest with an explicit dependency list. */
  function manifest(
    root: string,
    name: string,
    repositories: readonly string[],
    dependencies: readonly string[] = []
  ): void {
    write(
      root,
      `meta/distributions/${name}.yml`,
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
        "template:\n" +
        `  name: ${name}\n` +
        (dependencies.length
          ? "  dependencies:\n" + dependencies.map((url) => `    - url: ${url}\n`).join("")
          : "") +
        `  repositories: [${repositories.join(", ")}]\n` +
        "  files: [package.json]\n"
    );
  }

  it("builds a dependency chain in order and stops each closure at its upstream", async () => {
    const fixture = sourceFixture();
    manifest(fixture.root, "base", ["packages/runtime"]);
    manifest(fixture.root, "personal", ["panels/chat"], [URLS.base]);
    // Two edges from Base, which is the case a hardcoded base-as-provider got
    // wrong: it would hand this only Base's repositories.
    manifest(fixture.root, "system", ["packages/test-runtime"], [URLS.personal]);

    const prepared = await prepareDevelopmentWorkspaceDistributions({
      sourceRoot: fixture.root,
      outputRoot: fixture.output,
      urls: URLS,
    });

    // Each carries its own repositories and none of its upstreams'.
    expect(fs.existsSync(path.join(prepared.checkouts.system, "packages/test-runtime"))).toBe(true);
    expect(fs.existsSync(path.join(prepared.checkouts.system, "panels/chat"))).toBe(false);
    expect(fs.existsSync(path.join(prepared.checkouts.system, "packages/runtime"))).toBe(false);
    expect(fs.existsSync(path.join(prepared.checkouts.personal, "panels/chat"))).toBe(true);
    expect(fs.existsSync(path.join(prepared.checkouts.personal, "packages/runtime"))).toBe(false);
  });

  it("counts what an indirect dependency supplies, not just the nearest one", async () => {
    const fixture = sourceFixture();
    manifest(fixture.root, "base", ["packages/runtime"]);
    manifest(fixture.root, "personal", ["panels/chat"], [URLS.base]);
    // `panels/chat` reaches system through personal. Carrying a second copy is
    // exactly what the closure exists to prevent, so declaring it is refused.
    manifest(fixture.root, "system", ["panels/chat"], [URLS.personal]);

    await expect(
      prepareDevelopmentWorkspaceDistributions({
        sourceRoot: fixture.root,
        outputRoot: fixture.output,
        urls: URLS,
      })
    ).rejects.toThrow(/already provided by a declared dependency/u);
  });

  it("composes more than one upstream", async () => {
    const fixture = sourceFixture();
    manifest(fixture.root, "base", ["packages/runtime"]);
    manifest(fixture.root, "personal", ["panels/chat"], [URLS.base]);
    manifest(fixture.root, "system", ["packages/test-runtime"], [URLS.base, URLS.personal]);

    const prepared = await prepareDevelopmentWorkspaceDistributions({
      sourceRoot: fixture.root,
      outputRoot: fixture.output,
      urls: URLS,
    });

    expect(fs.existsSync(path.join(prepared.checkouts.system, "packages/test-runtime"))).toBe(true);
    expect(fs.existsSync(path.join(prepared.checkouts.system, "packages/runtime"))).toBe(false);
  });

  it("refuses a dependency no distribution in this build publishes", async () => {
    const fixture = sourceFixture();
    manifest(fixture.root, "personal", ["panels/chat"], ["git+https://example.test/absent.git"]);

    await expect(
      prepareDevelopmentWorkspaceDistributions({
        sourceRoot: fixture.root,
        outputRoot: fixture.output,
        urls: URLS,
      })
    ).rejects.toThrow(/which no development distribution publishes/u);
  });

  it("refuses a dependency cycle instead of looping", async () => {
    const fixture = sourceFixture();
    manifest(fixture.root, "base", ["packages/runtime"], [URLS.system]);
    manifest(fixture.root, "personal", ["panels/chat"]);
    manifest(fixture.root, "system", ["packages/test-runtime"], [URLS.base]);

    await expect(
      prepareDevelopmentWorkspaceDistributions({
        sourceRoot: fixture.root,
        outputRoot: fixture.output,
        urls: URLS,
      })
    ).rejects.toThrow(/form a cycle/u);
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
        urls: {
          base: "git+https://example.test/base.git",
          personal: "git+https://example.test/personal.git",
          system: "git+https://example.test/system.git",
        },
      })
    ).rejects.toThrow(/Distribution repository is missing/u);
    expect(fs.existsSync(fixture.output)).toBe(false);
  });
});

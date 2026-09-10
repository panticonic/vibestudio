import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import YAML from "yaml";
import { buildWorkspaceDistribution } from "../../src/dev/workspaceDistributionBuilder.js";
import { deriveE2eRootTemplate } from "./e2eRootTemplate.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const roots: string[] = [];
let previousSharedCache: string | undefined;

// Deriving a root template caches its checkout as profile-level derived data,
// so a test has to say where that profile is or it writes into the developer's.
beforeEach(() => {
  previousSharedCache = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
  const derived = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-root-template-derived-"));
  roots.push(derived);
  process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = derived;
});

afterEach(() => {
  if (previousSharedCache === undefined) delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
  else process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedCache;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("derives explicit Personal and ordinary project roots from their exact distributions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-private-distributions-"));
  roots.push(root);
  const sourceRoot = path.join(root, "authoring");
  fs.mkdirSync(path.join(sourceRoot, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "package.json"),
    '{"name":"@workspace/root","private":true}'
  );
  for (const [role, source] of [
    ["base", "panels/base"],
    ["personal", "panels/chat"],
    ["system", "about/new"],
  ]) {
    fs.mkdirSync(path.join(sourceRoot, source!), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, source!, "package.json"),
      JSON.stringify({ name: `@workspace-${source!.split("/")[0]}/${source!.split("/")[1]}` })
    );
    fs.writeFileSync(
      path.join(sourceRoot, "meta", `${role}.yml`),
      YAML.stringify({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: { name: role, repositories: [source], files: ["package.json"] },
        initPanels: [{ source }],
      })
    );
  }
  execFileSync("git", ["init", "-b", "main", sourceRoot], { stdio: "ignore" });
  execFileSync("git", ["-C", sourceRoot, "add", "-A"], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      sourceRoot,
      "-c",
      "user.name=E2E fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Fixture source",
    ],
    { stdio: "ignore" }
  );
  const build = (role: string) =>
    buildWorkspaceDistribution({
      sourceRoot,
      manifestPath: `meta/${role}.yml`,
      outputRoot: path.join(root, role),
      url: "git+https://example.test/defaults.git",
      ref: `refs/heads/${role}`,
    });
  const base = await build("base");
  const personal = await build("personal");
  const system = await build("system");
  const derived = await deriveE2eRootTemplate({
    base: {
      ...system,
      materializedSource: system.checkout,
      defaultTemplates: { base: base.pin, system: system.pin, personal: personal.pin },
      sources: [base, personal, system],
    },
    workRoot: path.join(root, "case"),
    distribution: "personal",
    configureSource: (checkout) => {
      const file = path.join(checkout, "meta/vibestudio.yml");
      const config = YAML.parse(fs.readFileSync(file, "utf8"));
      expect(config.initPanels[0].source).toBe("panels/chat");
      config.initPanels[0].stateArgs = { initialPrompt: "Preserve the opening turn" };
      fs.writeFileSync(file, YAML.stringify(config));
    },
  });
  expect(derived.defaultTemplates.personal).toEqual(derived.pin);
  expect(derived.pin).not.toEqual(personal.pin);
  expect(derived.defaultTemplates.system).toEqual(system.pin);
  expect(derived.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pin: derived.pin, checkout: derived.checkout }),
      system,
    ])
  );
  expect(derived.sources.at(-1)?.review).toEqual({
    presentation: { name: "personal" },
    repositories: ["panels/chat"],
    files: ["package.json"],
  });
  const runtime = YAML.parse(
    fs.readFileSync(path.join(derived.materializedSource, "meta/vibestudio.yml"), "utf8")
  );
  expect(runtime.initPanels).toEqual([
    { source: "panels/chat", stateArgs: { initialPrompt: "Preserve the opening turn" } },
  ]);

  const projectDerived = await deriveE2eRootTemplate({
    base: {
      ...system,
      materializedSource: system.checkout,
      defaultTemplates: { base: base.pin, system: system.pin, personal: personal.pin },
      sources: [base, personal, system],
    },
    workRoot: path.join(root, "project-case"),
    configureSource: (checkout) => {
      const config = YAML.parse(
        fs.readFileSync(path.join(checkout, "meta/vibestudio.yml"), "utf8")
      );
      expect(config.initPanels[0].source).toBe("panels/base");
    },
  });
  expect(projectDerived.pin).not.toEqual(system.pin);
  expect(projectDerived.defaultTemplates.base).toEqual(base.pin);
});

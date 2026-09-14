import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDevelopmentTemplateRoot,
  configuredDevelopmentTemplateRoot,
  selectDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
} from "./developmentTemplateConfig.js";

const roots: string[] = [];
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function repo(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibestudio-${name}-`));
  roots.push(root);
  git(root, "init");
  return fs.realpathSync(root);
}
function collection(): { host: string; root: string } {
  const host = repo("host");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-templates-"));
  roots.push(root);
  const registry = path.join(root, "registry");
  fs.mkdirSync(registry);
  git(registry, "init");
  fs.writeFileSync(
    path.join(registry, "registry.yml"),
    [
      "version: 1",
      "foundations:",
      ...["base", "personal", "system"].flatMap((name) => [
        `  - id: ${name}`,
        `    role: ${name}`,
        `    url: git+https://example.test/${name}.git`,
      ]),
      "development:",
      "  - id: system-testing",
      "    role: development",
      "    url: git+https://example.test/system-testing.git",
      "    consumers: [personal, system]",
      "entries:",
      "  - id: examples",
      "    url: git+https://example.test/examples.git",
      "",
    ].join("\n")
  );
  for (const name of ["base", "personal", "system", "system-testing", "examples"]) {
    const checkout = path.join(root, name);
    fs.mkdirSync(checkout);
    git(checkout, "init");
    git(checkout, "remote", "add", "origin", `https://example.test/${name}.git`);
  }
  return { host, root: fs.realpathSync(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("development template configuration", () => {
  it("stores a root containing the complete registry-defined checkout set", () => {
    const { host, root } = collection();
    expect(setDevelopmentTemplateRoot(host, root)).toMatchObject({
      root,
      sources: [
        expect.objectContaining({ id: "base", role: "base" }),
        expect.objectContaining({ id: "personal", role: "personal" }),
        expect.objectContaining({ id: "system", role: "system" }),
        expect.objectContaining({
          id: "system-testing",
          role: "development",
          consumers: ["personal", "system"],
        }),
        expect.objectContaining({ id: "examples", role: "optional" }),
      ],
    });
    expect(configuredDevelopmentTemplateRoot(host, {})).toBe(root);
    clearDevelopmentTemplateRoot(host);
    expect(configuredDevelopmentTemplateRoot(host, {})).toBeUndefined();
  });

  it("supports one explicit collection override", () => {
    const { host, root } = collection();
    expect(
      selectDevelopmentTemplateCheckouts(host, {
        env: { VIBESTUDIO_TEMPLATE_CHECKOUTS: root },
      })?.root
    ).toBe(root);
  });

  it("rejects an incomplete local universe instead of falling back per template", () => {
    const { host, root } = collection();
    fs.renameSync(path.join(root, "examples"), path.join(root, "examples-missing"));
    expect(() => setDevelopmentTemplateRoot(host, root)).toThrow(/examples.*not a Git checkout/u);
  });

  it("does not consult development checkouts for a production launch", () => {
    const { host, root } = collection();
    setDevelopmentTemplateRoot(host, root);
    expect(selectDevelopmentTemplateCheckouts(host, { productionTemplates: true })).toBeUndefined();
    expect(() =>
      selectDevelopmentTemplateCheckouts(host, { productionTemplates: true, explicitRoot: root })
    ).toThrow(/mutually exclusive/u);
  });
});

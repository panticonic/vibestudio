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
  fs.mkdirSync(path.join(host, "templates"));
  fs.writeFileSync(
    path.join(host, "templates", "registry.json"),
    JSON.stringify({
      version: 1,
      templates: [
        ...["base", "personal", "system"].map((name) => ({
          id: name,
          role: name,
          name,
          description: `${name} template`,
          url: `git+https://example.test/${name}.git`,
        })),
        {
          id: "system-testing",
          role: "development",
          name: "System testing",
          description: "Acceptance harness",
          url: "git+https://example.test/system-testing.git",
          consumers: ["personal", "system"],
        },
        {
          id: "examples",
          role: "catalog",
          name: "Examples",
          description: "Examples template",
          url: "git+https://example.test/examples.git",
        },
      ],
    })
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
          url: "git+https://example.test/system-testing.git",
          consumers: ["personal", "system"],
        }),
        expect.objectContaining({ id: "examples", role: "catalog" }),
      ],
    });
    expect(configuredDevelopmentTemplateRoot(host, {})).toBe(root);
    clearDevelopmentTemplateRoot(host);
    expect(configuredDevelopmentTemplateRoot(host, {})).toBeUndefined();
  });

  it("recognizes an actions/checkout origin without the optional .git suffix", () => {
    const { host, root } = collection();
    git(path.join(root, "base"), "remote", "set-url", "origin", "https://example.test/base");
    expect(setDevelopmentTemplateRoot(host, root).checkouts.base).toBe(path.join(root, "base"));
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

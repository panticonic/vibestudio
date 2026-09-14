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
  for (const name of ["base", "personal", "system"]) {
    const checkout = path.join(root, name);
    fs.mkdirSync(checkout);
    git(checkout, "init");
  }
  return { host, root: fs.realpathSync(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("development template configuration", () => {
  it("stores a root containing three independent Git checkouts", () => {
    const { host, root } = collection();
    expect(setDevelopmentTemplateRoot(host, root)).toMatchObject({ root });
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

  it("does not consult development checkouts for a production launch", () => {
    const { host, root } = collection();
    setDevelopmentTemplateRoot(host, root);
    expect(selectDevelopmentTemplateCheckouts(host, { productionTemplates: true })).toBeUndefined();
    expect(() =>
      selectDevelopmentTemplateCheckouts(host, { productionTemplates: true, explicitRoot: root })
    ).toThrow(/mutually exclusive/u);
  });
});

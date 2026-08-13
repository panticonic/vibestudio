import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDevelopmentBaseCheckout,
  configuredDevelopmentBaseCheckout,
  selectDevelopmentBaseCheckout,
  setDevelopmentBaseCheckout,
} from "./developmentBaseConfig.js";

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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("development Base configuration", () => {
  it("stores one canonical checkout in repository-local Git configuration", () => {
    const host = repo("host");
    const base = repo("base");

    expect(setDevelopmentBaseCheckout(host, base)).toBe(base);
    expect(configuredDevelopmentBaseCheckout(host, {})).toBe(base);

    clearDevelopmentBaseCheckout(host);
    expect(configuredDevelopmentBaseCheckout(host, {})).toBeUndefined();
  });

  it("allows an explicit environment override without changing the stored checkout", () => {
    const host = repo("host");
    const configured = repo("configured");
    const override = repo("override");
    setDevelopmentBaseCheckout(host, configured);

    expect(configuredDevelopmentBaseCheckout(host, { VIBESTUDIO_USERLAND_ROOT: override })).toBe(
      override
    );
    expect(configuredDevelopmentBaseCheckout(host, {})).toBe(configured);
  });

  it("selects the pinned production Base without mutating or consulting development config", () => {
    const host = repo("host");
    const configured = repo("configured");
    const override = repo("override");
    setDevelopmentBaseCheckout(host, configured);

    expect(
      selectDevelopmentBaseCheckout(host, {
        productionBase: true,
        env: { VIBESTUDIO_USERLAND_ROOT: override },
      })
    ).toBeUndefined();
    expect(configuredDevelopmentBaseCheckout(host, {})).toBe(configured);
    expect(() =>
      selectDevelopmentBaseCheckout(host, {
        productionBase: true,
        explicitCheckout: override,
      })
    ).toThrow(/mutually exclusive/u);
  });
});

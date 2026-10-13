import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveUserlandTestFilters } from "../scripts/lib/userland-test-filters.mjs";
import testOwnership from "../vitest.exactPairTests.json";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const ownedRoots: string[] = [];

afterEach(() => {
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-userland-filter-"));
  ownedRoots.push(parent);
  const root = path.join(parent, "host");
  const checkout = path.join(parent, "base");
  const hostPair = "tests/exact-pair.test.ts";
  const hostOnly = "tests/host-only.test.ts";
  const templateTest = "packages/example/src/example.test.ts";
  for (const file of [
    path.join(root, hostPair),
    path.join(root, hostOnly),
    path.join(checkout, templateTest),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  return {
    root,
    checkout,
    hostPair,
    hostOnly,
    templateTest,
    exactPairTests: [{ path: hostPair, template: "base" }],
  };
}

describe("userland test filter ownership", () => {
  it("resolves every declared exact-pair test from its host owner", () => {
    const paths = testOwnership.exactPairTests.map((test) => test.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const test of testOwnership.exactPairTests) {
      expect(fs.existsSync(path.join(repositoryRoot, test.path)), test.path).toBe(true);
      expect(
        resolveUserlandTestFilters({
          root: repositoryRoot,
          checkout: "/unused/template-checkout",
          template: test.template,
          filters: [test.path],
          exactPairTests: testOwnership.exactPairTests,
        })
      ).toEqual([path.join(repositoryRoot, test.path)]);
    }
  });

  it("resolves declared exact-pair tests from the host repository", () => {
    const setup = fixture();
    expect(
      resolveUserlandTestFilters({ ...setup, template: "base", filters: [setup.hostPair] })
    ).toEqual([path.join(setup.root, setup.hostPair)]);
  });

  it("resolves ordinary tests from the external template checkout", () => {
    const setup = fixture();
    expect(
      resolveUserlandTestFilters({ ...setup, template: "base", filters: [setup.templateTest] })
    ).toEqual([path.join(setup.checkout, setup.templateTest)]);
  });

  it("rejects an exact-pair test selected with the wrong template", () => {
    const setup = fixture();
    expect(() =>
      resolveUserlandTestFilters({ ...setup, template: "system", filters: [setup.hostPair] })
    ).toThrow("exact-pair test for template base, not system");
  });

  it("rejects host tests that have no declared template composition", () => {
    const setup = fixture();
    expect(() =>
      resolveUserlandTestFilters({ ...setup, template: "base", filters: [setup.hostOnly] })
    ).toThrow("host-owned but is not declared as an exact-pair test");
  });

  it("rejects filters outside either source repository", () => {
    const setup = fixture();
    expect(() =>
      resolveUserlandTestFilters({ ...setup, template: "base", filters: ["../escape.test.ts"] })
    ).toThrow("must stay inside its source repository");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { templateCheckoutHygieneFailures } from "../scripts/lib/template-checkout-hygiene.mjs";

const cleanup: string[] = [];

function fixture() {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "template-checkout-hygiene-"));
  cleanup.push(checkout);
  fs.mkdirSync(path.join(checkout, "packages", "runtime"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "packages", "runtime", "index.ts"), "export {};\n");
  return {
    checkout,
    selected: {
      sources: [{ id: "base" }],
      checkouts: { base: checkout },
    },
  };
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("development template checkout hygiene", () => {
  it("accepts a source-only checkout", () => {
    const { selected } = fixture();
    expect(templateCheckoutHygieneFailures(selected)).toEqual([]);
  });

  it("finds package-manager, compiler, test, and build artifacts at any depth", () => {
    const { checkout, selected } = fixture();
    fs.mkdirSync(path.join(checkout, "node_modules", ".vite"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "packages", "runtime", "dist"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "packages", "runtime", "tsconfig.tsbuildinfo"), "{}");

    expect(
      templateCheckoutHygieneFailures(selected)
        .map(({ artifact }) => artifact)
        .sort()
    ).toEqual(["node_modules", "packages/runtime/dist", "packages/runtime/tsconfig.tsbuildinfo"]);
  });
});

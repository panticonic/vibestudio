import { describe, expect, it, vi } from "vitest";
import { resolveTemplateClosure } from "./templateClosure.js";

function closure(
  graph: Record<string, readonly string[]>,
  options: {
    roots: readonly string[];
    provided?: ReadonlySet<string>;
    requires?: Record<string, readonly string[]>;
  }
) {
  const owners = Object.fromEntries(
    Object.keys(graph).map((repoPath) => [`pkg:${repoPath}`, repoPath])
  );
  return resolveTemplateClosure({
    roots: options.roots,
    ...(options.provided ? { provided: options.provided } : {}),
    packageDependenciesOf: (repoPath) => graph[repoPath] ?? [],
    ownerOfPackage: (name, dependent) => {
      const owner = owners[name];
      if (!owner) throw new Error(`${dependent} depends on missing package ${name}`);
      return owner;
    },
    requiredRepositoriesOf: (repoPath) => options.requires?.[repoPath] ?? [],
  });
}

describe("resolveTemplateClosure", () => {
  it("pulls in what a declared repository depends on, transitively", () => {
    const result = closure(
      {
        "panels/chat": ["pkg:packages/chat"],
        "packages/chat": ["pkg:packages/runtime"],
        "packages/runtime": [],
      },
      { roots: ["panels/chat"] }
    );
    expect(result.included).toEqual(["packages/chat", "packages/runtime", "panels/chat"]);
    // A review has to disclose what it dragged in, separately from what was asked for.
    expect(result.required).toEqual(["packages/chat", "packages/runtime"]);
  });

  it("stops at a repository a dependency already supplies", () => {
    const result = closure(
      {
        "panels/news": ["pkg:packages/runtime"],
        "packages/runtime": ["pkg:packages/base"],
        "packages/base": [],
      },
      { roots: ["panels/news"], provided: new Set(["packages/runtime"]) }
    );
    // Neither the provided repository nor anything reached only through it.
    expect(result.included).toEqual(["panels/news"]);
    expect(result.required).toEqual([]);
  });

  it("never admits a provided repository even when it is declared outright", () => {
    const result = closure(
      { "panels/chat": [] },
      {
        roots: ["panels/chat"],
        provided: new Set(["panels/chat"]),
      }
    );
    expect(result.included).toEqual([]);
  });

  it("follows requirements that are not package dependencies", () => {
    const result = closure(
      { "extensions/shell": [], "skills/terminal": [] },
      { roots: ["extensions/shell"], requires: { "extensions/shell": ["skills/terminal"] } }
    );
    expect(result.included).toEqual(["extensions/shell", "skills/terminal"]);
    expect(result.required).toEqual(["skills/terminal"]);
  });

  it("terminates on a dependency cycle rather than walking it forever", () => {
    const result = closure(
      { "packages/a": ["pkg:packages/b"], "packages/b": ["pkg:packages/a"] },
      { roots: ["packages/a"] }
    );
    expect(result.included).toEqual(["packages/a", "packages/b"]);
  });

  it("lets the caller phrase an unresolvable dependency", () => {
    expect(() =>
      closure({ "panels/chat": ["pkg:packages/missing"] }, { roots: ["panels/chat"] })
    ).toThrow(/panels\/chat depends on missing package pkg:packages\/missing/u);
  });

  it("asks about each repository once", () => {
    const deps = vi.fn((repoPath: string) =>
      repoPath === "panels/chat" ? ["pkg:packages/runtime"] : []
    );
    resolveTemplateClosure({
      roots: ["panels/chat", "panels/chat"],
      packageDependenciesOf: deps,
      ownerOfPackage: () => "packages/runtime",
    });
    expect(deps).toHaveBeenCalledTimes(2);
  });
});

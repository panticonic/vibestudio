import { describe, expect, it } from "vitest";

import {
  analyzeModuleImports,
  definitelyTypedCoordinate,
  moduleCoordinate,
} from "./moduleImports.js";

describe("analyzeModuleImports", () => {
  it("reports static, exported, dynamic, and CommonJS references with locations", () => {
    const source = [
      'import main, { type Shape, value as renamed } from "alpha";',
      'export { result } from "@scope/beta/subpath";',
      'const lazy = import("gamma");',
      'const legacy = require("delta");',
    ].join("\n");

    expect(analyzeModuleImports(source)).toMatchObject([
      {
        specifier: "alpha",
        syntax: "import",
        kind: "value",
        named: ["value"],
        hasDefault: true,
        line: 1,
      },
      {
        specifier: "@scope/beta/subpath",
        syntax: "export",
        kind: "value",
        named: ["result"],
        line: 2,
      },
      { specifier: "gamma", syntax: "dynamic-import", kind: "value", line: 3 },
      { specifier: "delta", syntax: "require", kind: "value", line: 4 },
    ]);
  });

  it("preserves type-only references for manifest analysis", () => {
    const references = analyzeModuleImports(
      'import type { Root } from "mdast";\nimport { type A, type B } from "types-only";'
    );

    expect(references).toMatchObject([
      { specifier: "mdast", kind: "type", named: [] },
      { specifier: "types-only", kind: "type", named: [] },
    ]);
  });

  it("does not invent imports from comments, strings, templates, or regex literals", () => {
    const source = [
      '// import "commented";',
      'const example = "import fake from \\"string-package\\"";',
      'const embedded = `require("template-package")`;',
      'const matcher = /import x from "regex-package"/;',
      'import real from "real-package";',
    ].join("\n");

    expect(analyzeModuleImports(source).map(({ specifier }) => specifier)).toEqual([
      "real-package",
    ]);
  });

  it("uses JavaScript grammar after control-flow parentheses and rejects member require calls", () => {
    const source = [
      'if (enabled) /import fake from "regex-after-if"/.test(input);',
      'while (pending) /require\\("regex-after-while"\\)/.test(input);',
      'client.require("member-package");',
      'client?.require("optional-member-package");',
      'const direct = require /* dependency */ ("direct-package");',
      'import real from "real-package";',
    ].join("\n");

    expect(analyzeModuleImports(source).map(({ specifier }) => specifier)).toEqual([
      "direct-package",
      "real-package",
    ]);
  });

  it("reports TypeScript export-type references without changing source coordinates", () => {
    const source = [
      'export type { Model } from "typed-export";',
      'export type * from "typed-namespace";',
    ].join("\n");

    expect(analyzeModuleImports(source)).toMatchObject([
      {
        specifier: "typed-export",
        syntax: "export",
        kind: "type",
        hasNamespace: false,
        line: 1,
      },
      {
        specifier: "typed-namespace",
        syntax: "export",
        kind: "type",
        hasNamespace: false,
        line: 2,
      },
    ]);
  });

  it("parses TSX as one grammar instead of treating JSX text as module syntax", () => {
    const source = [
      'import type { ReactNode } from "react";',
      'import { useMemo } from "react";',
      "type Props = { child: ReactNode };",
      "export function View({ child }: Props) {",
      "  return <section data-example={'require(\"jsx-text\")'}>{useMemo(() => child, [child])}</section>;",
      "}",
    ].join("\n");

    expect(analyzeModuleImports(source)).toMatchObject([
      { specifier: "react", syntax: "import", kind: "type", line: 1 },
      {
        specifier: "react",
        syntax: "import",
        kind: "value",
        named: ["useMemo"],
        line: 2,
      },
    ]);
  });

  it("analyzes executable template interpolations while ignoring literal template text", () => {
    const source = [
      "const loaded = `literal import('ignored') ${",
      '  condition ? import("interpolated-package") : `${require("nested-package")}`',
      "}`;",
    ].join("\n");

    expect(analyzeModuleImports(source)).toMatchObject([
      {
        specifier: "interpolated-package",
        syntax: "dynamic-import",
        kind: "value",
        line: 2,
      },
      {
        specifier: "nested-package",
        syntax: "require",
        kind: "value",
        line: 2,
      },
    ]);
  });

  it("normalizes package coordinates and excludes platform built-ins", () => {
    expect(moduleCoordinate("@scope/name/subpath")).toBe("@scope/name");
    expect(moduleCoordinate("plain/subpath")).toBe("plain");
    expect(moduleCoordinate("node:fs")).toBeNull();
    expect(moduleCoordinate("fs/promises")).toBeNull();
    expect(moduleCoordinate("./local.js")).toBeNull();
    expect(definitelyTypedCoordinate("mdast")).toBe("@types/mdast");
    expect(definitelyTypedCoordinate("@scope/name")).toBe("@types/scope__name");
  });
});

import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { vcsApplyEditsInputSchema, vcsEditOpSchema } from "./vcs.js";

describe("vcsEditOpSchema — ergonomic shorthand coercion", () => {
  it("accepts the natural { path, content: string } form → strict write", () => {
    expect(vcsEditOpSchema.parse({ path: "projects/a.txt", content: "hello" })).toEqual({
      kind: "write",
      path: "projects/a.txt",
      content: { kind: "text", text: "hello" },
    });
  });

  it("coerces string content even when kind is explicit (write/create)", () => {
    expect(vcsEditOpSchema.parse({ kind: "create", path: "a", content: "x" })).toEqual({
      kind: "create",
      path: "a",
      content: { kind: "text", text: "x" },
    });
  });

  it("accepts upsert as the conventional create-or-overwrite alias", () => {
    expect(vcsEditOpSchema.parse({ kind: "upsert", path: "a", content: "x" })).toEqual({
      kind: "write",
      path: "a",
      content: { kind: "text", text: "x" },
    });
  });

  it("accepts legacy fileEdits/op batches at the service boundary", () => {
    expect(
      vcsApplyEditsInputSchema.parse({
        fileEdits: [
          { op: "add", path: "projects/example.txt", content: "hello" },
          { op: "remove", path: "projects/old.txt" },
        ],
      })
    ).toEqual({
      edits: [
        {
          kind: "create",
          path: "projects/example.txt",
          content: { kind: "text", text: "hello" },
        },
        { kind: "delete", path: "projects/old.txt" },
      ],
    });
  });

  it("accepts natural exact-text replacement forms", () => {
    expect(vcsEditOpSchema.parse({ path: "a", oldText: "before", newText: "after" })).toEqual({
      kind: "replaceText",
      path: "a",
      oldText: "before",
      newText: "after",
    });
    expect(
      vcsEditOpSchema.parse({ kind: "replace", path: "a", oldText: "x", newText: "y" })
    ).toEqual({ kind: "replaceText", path: "a", oldText: "x", newText: "y" });
  });

  it("preserves explicit strict forms unchanged", () => {
    const strict = { kind: "write", path: "a", content: { kind: "text", text: "y" }, mode: 0o644 };
    expect(vcsEditOpSchema.parse(strict)).toEqual(strict);
    expect(vcsEditOpSchema.parse({ kind: "delete", path: "a" })).toEqual({
      kind: "delete",
      path: "a",
    });
  });

  it("still rejects a genuinely malformed edit (no kind, no content)", () => {
    expect(() => vcsEditOpSchema.parse({ path: "a" })).toThrow();
  });

  it("fails LOUD on a mis-keyed discriminator (`type` instead of `kind`) rather than guessing", () => {
    // The recurring agent mistake: `{ type: "write", content: "..." }`. Previously the content
    // default silently turned it into a write, masking the wrong key — and `{ type: "replace" }`
    // would have silently become a write too. Now it names the fix.
    expect(() => vcsEditOpSchema.parse({ type: "write", path: "a", content: "x" })).toThrow(
      /discriminated by "kind", not "type"/
    );
    expect(() => vcsEditOpSchema.parse({ type: "replace", path: "a" })).toThrow(/kind.*not.*type/);
    // It surfaces through safeParse too (the dispatcher path), not just parse.
    expect(() => vcsEditOpSchema.safeParse({ type: "delete", path: "a" })).toThrow(/kind/);
  });

  it("keeps the discriminated union visible in the serialized schema (help discovery unchanged)", () => {
    // zod-to-json-schema renders a preprocess via its inner schema, so help('vcs') still shows the
    // strict edit kinds — the shorthand is an accepted superset, not a replacement.
    const json = JSON.stringify(zodToJsonSchema(vcsApplyEditsInputSchema, { target: "openApi3" }));
    for (const kind of ["replace", "replaceText", "write", "create", "delete", "chmod"]) {
      expect(json).toContain(kind);
    }
  });
});

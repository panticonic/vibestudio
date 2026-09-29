// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DOM_SNAPSHOT_EXPRESSION, snapshotDocument } from "./domSnapshot.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe.each([
  ["panel API", snapshotDocument],
  [
    "native renderer expression",
    (document: Document) =>
      new Function("document", `return ${DOM_SNAPSHOT_EXPRESSION}`)(document) as ReturnType<
        typeof snapshotDocument
      >,
  ],
] as const)("bounded rendered document via %s", (_surface, snapshot) => {
  it("excludes script, style and hidden subtrees from text and structure", () => {
    document.body.innerHTML = `<main><h1>Task manager</h1><p>Test launch</p></main>
      <script>${"boot-secret ".repeat(4000)}</script><style>.internal{color:red}</style>
      <div hidden>hidden text</div><div style="display:none">display-none text</div>
      <div style="visibility:hidden">invisible text <span style="visibility:visible">visible override</span></div>`;
    const result = snapshot(document);
    expect(result.text).toBe("Task manager\nTest launch\nvisible override");
    expect(JSON.stringify(result.structure)).not.toMatch(
      /boot-secret|internal|hidden text|display-none text|invisible text/
    );
    expect(result.truncated).toBe(false);
  });
  it("preserves global size bounds when rendered content is large", () => {
    const main = document.createElement("main");
    for (let i = 0; i < 600; i++) {
      const span = document.createElement("span");
      span.textContent = "x".repeat(200);
      main.append(span);
    }
    document.body.append(main);
    const result = snapshot(document);
    expect(result.text.length).toBeLessThanOrEqual(result.limits.textCharacters);
    expect(result.observed.textNodes).toBeLessThanOrEqual(result.limits.textNodes);
    expect(result.observed.structureNodes).toBeLessThanOrEqual(result.limits.structureNodes);
    expect(result.truncated).toBe(true);
  });
});

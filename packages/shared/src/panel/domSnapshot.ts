/** One bounded document contract for native hosts and the panel agent API.
 * Self-contained so native hosts can evaluate the same function in a renderer.
 * No layout traversal, full accessibility traversal, or source-code text. */
interface SnapshotNode {
  nodeType: number;
  nodeValue: string | null;
  parentElement: SnapshotElement | null;
}
interface SnapshotElement extends SnapshotNode {
  tagName: string;
  children: { readonly length: number; readonly [index: number]: SnapshotElement };
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}
interface SnapshotDocument {
  body: SnapshotElement | null;
  defaultView: {
    getComputedStyle(element: unknown): { display: string; visibility: string };
  } | null;
  createTreeWalker(
    root: unknown,
    whatToShow: number,
    filter: { acceptNode(node: SnapshotNode): number }
  ): { nextNode(): SnapshotNode | null };
}

export function snapshotDocument(document: SnapshotDocument) {
  const limits = {
    textCharacters: 32_768,
    textNodes: 2_000,
    structureNodes: 500,
    depth: 8,
    childrenPerNode: 50,
    leafTextCharacters: 160,
  };
  let truncated = false;
  let textNodes = 0;
  let structureNodes = 0;
  const excluded = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  const visible = new WeakMap<SnapshotElement, boolean>();
  const reader = {
    included(element: SnapshotElement): boolean {
      const known = visible.get(element);
      if (known !== undefined) return known;
      const style = document.defaultView?.getComputedStyle(element);
      const result =
        !excluded.has(element.tagName) &&
        !element.hasAttribute("hidden") &&
        style?.display !== "none" &&
        (!element.parentElement || this.included(element.parentElement));
      visible.set(element, result);
      return result;
    },
    textOf(root: SnapshotElement, maximum: number, count: boolean): string {
      const chunks: string[] = [];
      let length = 0;
      let nodes = 0;
      const walker = document.createTreeWalker(root, 5, {
        acceptNode(node) {
          if (node.nodeType === 1) return reader.included(node as SnapshotElement) ? 3 : 2;
          const parent = node.parentElement;
          const style = parent && document.defaultView?.getComputedStyle(parent);
          return parent &&
            reader.included(parent) &&
            style?.visibility !== "hidden" &&
            style?.visibility !== "collapse"
            ? 1
            : 2;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (nodes >= limits.textNodes) {
          truncated = true;
          break;
        }
        nodes += 1;
        if (count) textNodes += 1;
        const value = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
        if (!value) continue;
        const separator = chunks.length ? "\n" : "";
        const remaining = maximum - length - separator.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        chunks.push(separator + value.slice(0, remaining));
        length += separator.length + Math.min(value.length, remaining);
        if (value.length > remaining) {
          truncated = true;
          break;
        }
      }
      return chunks.join("");
    },
    describe(element: SnapshotElement, depth = 0): unknown {
      if (!this.included(element)) return null;
      if (structureNodes >= limits.structureNodes) {
        truncated = true;
        return null;
      }
      structureNodes += 1;
      const children: unknown[] = [];
      const childCount = element.children.length;
      if (depth >= limits.depth) {
        if (childCount) truncated = true;
      } else {
        if (childCount > limits.childrenPerNode) truncated = true;
        for (let index = 0; index < Math.min(childCount, limits.childrenPerNode); index += 1) {
          const child = this.describe(element.children[index]!, depth + 1);
          if (child) children.push(child);
          if (structureNodes >= limits.structureNodes) break;
        }
      }
      if (children.length === 0) {
        const style = document.defaultView?.getComputedStyle(element);
        if (style?.visibility === "hidden" || style?.visibility === "collapse") return null;
      }
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? undefined,
        label: element.getAttribute("aria-label") ?? undefined,
        text: childCount === 0 ? this.textOf(element, limits.leafTextCharacters, false) : undefined,
        children,
        depth,
      };
    },
  };
  const text =
    document.body && reader.included(document.body)
      ? reader.textOf(document.body, limits.textCharacters, true)
      : "";
  return {
    kind: "synth" as const,
    text,
    structure: document.body ? reader.describe(document.body) : null,
    truncated,
    limits,
    observed: { textNodes, structureNodes },
  };
}

export const DOM_SNAPSHOT_EXPRESSION = `(${snapshotDocument.toString()})(document)`;
export type PanelDomSnapshot = ReturnType<typeof snapshotDocument>;

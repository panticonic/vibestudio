import type { FlattenedPanel } from "../shell/hooks/index.js";

/**
 * Compute a per-row connector descriptor from a depth-first flattened tree.
 * Runtime is proportional to the input plus the guide text produced; sibling
 * discovery never scans ahead through the remaining rows.
 */
export function buildGuides(items: readonly FlattenedPanel[]): Map<string, string> {
  const isLast = new Array<boolean>(items.length).fill(true);
  const previousChildByParent = new Map<string | null, number>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const previousSibling = previousChildByParent.get(item.parentId);
    if (previousSibling !== undefined) isLast[previousSibling] = false;
    previousChildByParent.set(item.parentId, index);
  }

  const guides = new Map<string, string>();
  const lastById = new Map<string, boolean>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const itemIsLast = isLast[index] ?? true;
    lastById.set(item.id, itemIsLast);
    if (item.depth === 0) {
      guides.set(item.id, "");
      continue;
    }

    const parentGuide = item.parentId ? (guides.get(item.parentId) ?? "") : "";
    const parentContinues = item.parentId ? !(lastById.get(item.parentId) ?? true) : false;
    const ancestorColumns =
      parentGuide.length === 0 ? "" : `${parentGuide.slice(0, -1)}${parentContinues ? "v" : " "}`;
    guides.set(item.id, `${ancestorColumns}${itemIsLast ? "L" : "T"}`);
  }
  return guides;
}

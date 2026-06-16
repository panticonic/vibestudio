import type { ToolVcs, ToolVcsApplyResult, ToolVcsEditOp } from "../tool-vcs.js";

export interface StubVcsInit {
  files?: Record<string, string>;
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

function cleanResult(edits: ToolVcsEditOp[], stateHash: string): ToolVcsApplyResult {
  return {
    status: "clean",
    stateHash,
    eventId: `event-${stateHash}`,
    headHash: `head-${stateHash}`,
    conflicts: [],
    changedPaths: edits.map((edit) => normalize(edit.path)),
  };
}

function conflictedResult(path: string, stateHash: string): ToolVcsApplyResult {
  return {
    status: "conflicted",
    stateHash,
    eventId: null,
    headHash: null,
    conflicts: [{ path, kind: "content" }],
    changedPaths: [],
  };
}

export class StubVcs implements ToolVcs {
  readonly files = new Map<string, string>();
  private version = 0;

  constructor(init?: StubVcsInit) {
    for (const [path, text] of Object.entries(init?.files ?? {})) {
      this.files.set(normalize(path), text);
    }
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path));
  }

  async readFile(
    path: string
  ): Promise<{ content: { kind: "text"; text: string }; stateHash: string } | null> {
    const text = this.read(path);
    if (text == null) return null;
    return { content: { kind: "text", text }, stateHash: `state-${this.version}` };
  }

  async applyEdits(input: { edits: ToolVcsEditOp[] }): Promise<ToolVcsApplyResult> {
    for (const edit of input.edits) {
      const path = normalize(edit.path);
      if (edit.kind === "write" || edit.kind === "create") {
        if (edit.content.kind !== "text") {
          throw new Error("StubVcs only supports text content");
        }
        this.files.set(path, edit.content.text);
        continue;
      }
      if (edit.kind === "delete") {
        this.files.delete(path);
        continue;
      }
      if (edit.kind === "chmod") continue;

      const existing = this.files.get(path);
      if (existing == null) return conflictedResult(path, `state-${this.version}`);
      let next = existing;
      const hunks = [...edit.hunks].sort((a, b) => b.start - a.start);
      for (const hunk of hunks) {
        if (hunk.oldText != null && next.slice(hunk.start, hunk.end) !== hunk.oldText) {
          return conflictedResult(path, `state-${this.version}`);
        }
        next = next.slice(0, hunk.start) + hunk.newText + next.slice(hunk.end);
      }
      this.files.set(path, next);
    }
    this.version++;
    return cleanResult(input.edits, `state-${this.version}`);
  }
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RETIRED_CHANNEL_ENVELOPE_METHODS = [
  "getChannelReplayWindow",
  "listChannelEnvelopesAfter",
  "listChannelEnvelopesBefore",
  "getInitialChannelWindow",
  "listChannelEnvelopes",
] as const;

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("channel envelope skill documentation", () => {
  it("uses only the unified paging API", () => {
    const roots = [join(process.cwd(), "workspace/skills"), join(process.cwd(), "skills")];
    const stale = roots.flatMap(markdownFiles).flatMap((path) => {
      const contents = readFileSync(path, "utf8");
      return RETIRED_CHANNEL_ENVELOPE_METHODS.filter((method) => contents.includes(method)).map(
        (method) => `${path}: ${method}`
      );
    });

    expect(stale).toEqual([]);
  });
});

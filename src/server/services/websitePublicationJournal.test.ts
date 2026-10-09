import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebsitePublicationJournal } from "./websitePublicationJournal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const intent = {
  operationId: "publish-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  provider: "example",
  destination: "account/site",
  environment: "preview" as const,
};
function journalPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
  roots.push(root);
  return path.join(root, "journal.json");
}

describe("publication journal", () => {
  it("restores completed phases and rejects a changed intent after restart", () => {
    const filePath = journalPath();
    const first = new WebsitePublicationJournal({ filePath });
    first.begin(intent);
    first.record(intent, { phase: "uploaded" });
    const restarted = new WebsitePublicationJournal({ filePath });
    expect(restarted.begin(intent)).toMatchObject({ phase: "uploaded" });
    expect(() => restarted.begin({ ...intent, destination: "another/site" })).toThrow(
      /bound to artifact/
    );
    expect(() => restarted.record(intent, { phase: "destination-ready" })).toThrow(/cannot record/);
  });

  it("does not advance memory when the durable write fails", () => {
    const filePath = journalPath();
    const journal = new WebsitePublicationJournal({ filePath });
    journal.begin(intent);
    fs.unlinkSync(filePath);
    fs.mkdirSync(filePath);
    expect(() => journal.record(intent, { phase: "uploaded" })).toThrow();
    expect(journal.get(intent.operationId)).toMatchObject({ phase: "prepared" });
  });
});

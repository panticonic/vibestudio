import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadVcsCommandJournalEntry,
  saveVcsCommandJournalEntry,
  vcsCommandJournalPath,
  type VcsCommandJournalEntry,
} from "./vcsCommandJournal.js";

describe("VCS command retry journal", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-vcs-journal-"));
    vi.stubEnv("XDG_CONFIG_HOME", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("durably stores one exact request under a server and context identity", () => {
    const entry: VcsCommandJournalEntry = {
      schemaVersion: 1,
      serverUrl: "https://studio.example.test",
      contextId: "context:1",
      commandId: "command:move",
      method: "move",
      intent: { source: "packages/a/a.ts", destination: "packages/b/a.ts" },
      input: {
        contextId: "context:1",
        commandId: "command:move",
        expectedWorkingHead: { kind: "event", eventId: "event:before" },
      },
      createdAt: 1,
    };

    saveVcsCommandJournalEntry(entry);

    expect(loadVcsCommandJournalEntry(entry)).toEqual(entry);
    expect(fs.statSync(vcsCommandJournalPath(entry)).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace an existing command with a different request", () => {
    const entry: VcsCommandJournalEntry = {
      schemaVersion: 1,
      serverUrl: "https://studio.example.test",
      contextId: "context:1",
      commandId: "command:push",
      method: "push",
      intent: {},
      input: { commandId: "command:push", expectedMainEventId: "event:old" },
      createdAt: 1,
    };
    saveVcsCommandJournalEntry(entry);

    expect(() =>
      saveVcsCommandJournalEntry({
        ...entry,
        input: { commandId: "command:push", expectedMainEventId: "event:new" },
      })
    ).toThrow(/different durable request/);
  });
});

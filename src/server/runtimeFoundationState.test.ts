import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateLayout } from "./stateLayout.js";
import {
  ensureRuntimeFoundationStateCompatible,
  IncompatibleRuntimeFoundationStateError,
  resetRuntimeFoundationState,
} from "./runtimeFoundationState.js";

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vs-foundation-state-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const entry of roots.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

describe("runtime foundation state cutover", () => {
  it("establishes the current marker for clean state and accepts it thereafter", () => {
    const statePath = root();
    ensureRuntimeFoundationStateCompatible(statePath);
    expect(
      JSON.parse(fs.readFileSync(stateLayout(statePath).runtimeFoundationFormatFile, "utf8"))
    ).toMatchObject({ version: 2 });
    expect(() => ensureRuntimeFoundationStateCompatible(statePath)).not.toThrow();
  });

  it("names the scoped reset when a pre-R3 authority store exists", () => {
    const statePath = root();
    fs.writeFileSync(stateLayout(statePath).capabilityGrantsFile, JSON.stringify({ grants: [] }));
    expect(() => ensureRuntimeFoundationStateCompatible(statePath)).toThrowError(
      expect.objectContaining<Partial<IncompatibleRuntimeFoundationStateError>>({
        code: "RUNTIME_FOUNDATION_STATE_INCOMPATIBLE",
        message: expect.stringContaining("vibestudio runtime-foundations reset"),
      })
    );
  });

  it("removes rebuildable foundations while preserving source, content, and recovery state", () => {
    const statePath = root();
    const layout = stateLayout(statePath);
    const resetFiles = [
      layout.capabilityGrantsFile,
      path.join(layout.buildsDir, "build", "artifact"),
      path.join(layout.runtimeDiagnosticsDir, "unit.json"),
      layout.runtimeIncarnationsFile,
    ];
    const preservedFiles = [
      path.join(layout.refsDir, "refs.json"),
      path.join(layout.blobsDir, "sha256", "aa"),
      path.join(layout.contextsDir, "work"),
      path.join(layout.databases.workerdDoDir, "db.sqlite"),
      layout.gitImportJournalFile,
      path.join(layout.webrtc.root, "identity.pem"),
    ];
    for (const file of [...resetFiles, ...preservedFiles]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "owned");
    }

    const result = resetRuntimeFoundationState(statePath);
    expect(resetFiles.every((file) => !fs.existsSync(file))).toBe(true);
    expect(preservedFiles.every((file) => fs.readFileSync(file, "utf8") === "owned")).toBe(true);
    expect(result.preserved).toContain(layout.databases.root);
    expect(JSON.parse(fs.readFileSync(layout.runtimeFoundationFormatFile, "utf8"))).toMatchObject({
      version: 2,
    });
  });

  it("refuses while the ready file names a live runtime", () => {
    const statePath = root();
    fs.writeFileSync(stateLayout(statePath).serverReadyFile, JSON.stringify({ pid: process.pid }));
    expect(() => resetRuntimeFoundationState(statePath)).toThrow(/still running/);
  });
});

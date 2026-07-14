import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateLayout } from "../server/stateLayout.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-foundation-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime-foundations reset CLI", () => {
  it("requires explicit confirmation", async () => {
    const { main } = await import("./client.js");
    await expect(
      main(["runtime-foundations", "reset", "--state-path", root, "--json"])
    ).resolves.toBe(2);
    expect(fs.existsSync(stateLayout(root).runtimeFoundationFormatFile)).toBe(false);
  });

  it("resets an explicit offline state directory and reports preserved scope", async () => {
    const layout = stateLayout(root);
    fs.mkdirSync(layout.buildsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.buildsDir, "old"), "artifact");
    fs.mkdirSync(layout.refsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.refsDir, "refs.json"), "source");
    const { main } = await import("./client.js");
    await expect(
      main(["runtime-foundations", "reset", "--state-path", root, "--confirm", "--json"])
    ).resolves.toBe(0);
    expect(fs.existsSync(layout.buildsDir)).toBe(false);
    expect(fs.readFileSync(path.join(layout.refsDir, "refs.json"), "utf8")).toBe("source");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"formatVersion":2'));
  });
});

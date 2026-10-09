import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Module } from "node:module";
import { expect, it, vi } from "vitest";
import { EncryptedJsonStore } from "./encryptedJsonStore.js";

class NativeProbeStore extends EncryptedJsonStore<{ token: string }> {
  constructor(basePath: string) {
    super({ basePath, defaultBasePath: basePath });
  }
  save(value: { token: string }) {
    return this.saveRecord("provider", "account", value);
  }
  remove() {
    return this.removeRecord("provider", "account");
  }
  load() {
    return this.loadRecord("provider", "account");
  }
}

it("encrypts ordinary Node records without acquiring an Electron executable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vibestudio-node-cipher-"));
  const loader = Module as unknown as { _load(request: string, ...args: unknown[]): unknown };
  const original = loader._load;
  const electronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
  let electronRequests = 0;
  Reflect.deleteProperty(process.versions, "electron");
  const probe = vi.spyOn(loader, "_load").mockImplementation((request, ...args) => {
    if (request === "electron") {
      electronRequests += 1;
      throw new Error("Node cannot own safeStorage");
    }
    return original.call(Module, request, ...args);
  });
  try {
    const store = new NativeProbeStore(directory);
    const value = { token: "unit-secret-do-not-persist-as-plaintext" };
    await store.save(value);
    const raw = await readFile(path.join(directory, "provider/account.json"), "utf8");
    expect(JSON.parse(raw).v).toBe("v1-aesgcm");
    expect(raw).not.toContain(value.token);
    expect(await store.load()).toEqual(value);
    expect(electronRequests).toBe(0);
  } finally {
    probe.mockRestore();
    if (electronVersion) Object.defineProperty(process.versions, "electron", electronVersion);
    await rm(directory, { recursive: true, force: true });
  }
});

it("observes replacements and deletions made by a separate credential owner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vibestudio-owner-observation-"));
  const reader = new NativeProbeStore(directory);
  const writer = new NativeProbeStore(directory);
  const controller = new AbortController();
  try {
    const initial = await reader.observeChanges();
    const changed = reader.observeChanges({
      afterVersion: initial.version,
      signal: controller.signal,
    });
    await writer.save({ token: "owner-secret" });
    const replacement = await changed;
    expect(replacement.version).not.toBe(initial.version);
    expect(replacement.version).not.toContain("owner-secret");
    const deleted = reader.observeChanges({
      afterVersion: replacement.version,
      signal: controller.signal,
    });
    await writer.remove();
    expect(await deleted).toEqual(initial);
    const cancelled = reader.observeChanges({
      afterVersion: initial.version,
      signal: controller.signal,
    });
    const reason = new Error("setup closed");
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    // A closed observation owns neither the writer nor its records.
    await writer.save({ token: "still-owned" });
    expect(await reader.load()).toEqual({ token: "still-owned" });
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

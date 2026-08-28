import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateNodeEndpointSecret } from "./nodeSecret.js";

describe("durable Node endpoint secret", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function filename(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "iroh-secret-"));
    roots.push(root);
    return path.join(root, "identity", "endpoint.key");
  }

  it("persists one stable 0600 secret below a 0700 directory", () => {
    const file = filename();
    const first = loadOrCreateNodeEndpointSecret(file);
    const second = loadOrCreateNodeEndpointSecret(file);
    expect(second.public().toString()).toBe(first.public().toString());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("fails loud when reach state outlives its endpoint identity", () => {
    expect(() =>
      loadOrCreateNodeEndpointSecret(filename(), { advertisedReachExists: true })
    ).toThrow(/missing.*advertised reach/i);
  });

  it("rejects malformed state instead of rotating identity", () => {
    const file = filename();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(31));
    expect(() => loadOrCreateNodeEndpointSecret(file)).toThrow(/exactly 32 bytes/);
  });
});

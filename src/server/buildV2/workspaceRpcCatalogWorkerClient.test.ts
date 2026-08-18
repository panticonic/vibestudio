import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceRpcCatalogWorkerEntry,
  WorkspaceRpcCatalogWorkerClient,
} from "./workspaceRpcCatalogWorkerClient.js";

const roots: string[] = [];
const clients: WorkspaceRpcCatalogWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("WorkspaceRpcCatalogWorkerClient", () => {
  it("resolves the source-mode worker bootstrap", () => {
    expect(resolveWorkspaceRpcCatalogWorkerEntry(process.cwd())).toBe(
      path.join(process.cwd(), "src/server/buildV2/workspaceRpcCatalogWorkerBootstrap.mjs")
    );
  });

  it("parses a large catalog without occupying the server event loop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-worker-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "provider.ts"),
      `declare const root: any;
       const generated = root${".value".repeat(12_000)};
       class NotesDO {
         @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
         async getNote(): Promise<void> {}
       }`
    );
    const client = new WorkspaceRpcCatalogWorkerClient(process.cwd());
    clients.push(client);

    let timerAdvanced = false;
    setTimeout(() => {
      timerAdvanced = true;
    }, 0);
    const catalog = await client.collect(root, {
      provider: "workers/notes",
      authority: { requests: [], provides: [] },
    });

    expect(timerAdvanced).toBe(true);
    expect(catalog).toEqual([expect.objectContaining({ name: "getNote" })]);
  });
});

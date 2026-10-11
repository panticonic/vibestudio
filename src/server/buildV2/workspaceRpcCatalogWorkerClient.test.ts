import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceRpcCatalogWorkerEntry,
  WorkspaceRpcCatalogWorkerClient,
} from "./workspaceRpcCatalogWorkerClient.js";
import { BuildDiagnosticsError } from "./diagnostics.js";
import { resolveNativeTypeScriptServerPath, TYPESCRIPT_SERVER_PATH_ENV } from "../appRoot.js";

const roots: string[] = [];
const clients: WorkspaceRpcCatalogWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("WorkspaceRpcCatalogWorkerClient", () => {
  it("retains source declaration diagnostics across the native worker boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-worker-invalid-"));
    roots.push(root);
    const file = path.join(root, "provider.ts");
    fs.writeFileSync(
      file,
      `class NotesDO {
      @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
      async getNote(): Promise<void> {}
    }`
    );
    const client = new WorkspaceRpcCatalogWorkerClient();
    clients.push(client);
    let caught: unknown;
    try {
      await client.collect(root, {
        provider: "workers/notes",
        authority: { requests: [], provides: [] },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BuildDiagnosticsError);
    expect((caught as BuildDiagnosticsError).diagnostics).toEqual([
      {
        source: "schema",
        severity: "error",
        file,
        line: 2,
        column: 7,
        message: "provider.ts:getNote requires a static website exposure decision",
        suggestion:
          'Declare a static website policy: { kind: "closed", reason: "..." } or { kind: "eligible", rationale: "..." }, inline or as a module-level const. Choose the exposure intentionally; see skills/workspace-dev/WORKERS.md.',
      },
    ]);
  });
  it("resolves the compiled generation worker", () => {
    expect(resolveWorkspaceRpcCatalogWorkerEntry()).toBe(
      path.join(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "workspace-rpc-catalog-worker.mjs")
    );
  });

  it("uses the explicitly owned physical TypeScript executable in its worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-worker-physical-ts-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "provider.ts"),
      `class NotesDO {
        @rpc({ website: { kind: "eligible", rationale: "Explicit receiver exposure for this physical compiler fixture." }, principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
        async getNote(): Promise<void> {}
      }`
    );
    const priorPath = process.env[TYPESCRIPT_SERVER_PATH_ENV];
    process.env[TYPESCRIPT_SERVER_PATH_ENV] = path.join(root, "missing-tsserver");
    const client = new WorkspaceRpcCatalogWorkerClient(
      resolveNativeTypeScriptServerPath(process.cwd())
    );
    clients.push(client);
    try {
      await expect(
        client.collect(root, {
          provider: "workers/notes",
          authority: { requests: [], provides: [] },
        })
      ).resolves.toEqual([expect.objectContaining({ name: "getNote" })]);
    } finally {
      if (priorPath === undefined) delete process.env[TYPESCRIPT_SERVER_PATH_ENV];
      else process.env[TYPESCRIPT_SERVER_PATH_ENV] = priorPath;
    }
  });

  it("parses a large catalog without occupying the server event loop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-worker-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "provider.ts"),
      `declare const root: any;
       const generated = root${".value".repeat(12_000)};
       class NotesDO {
         @rpc({ website: {"kind":"eligible","rationale":"Explicit receiver exposure for this test fixture."}, principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
         async getNote(): Promise<void> {}
       }`
    );
    const client = new WorkspaceRpcCatalogWorkerClient();
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

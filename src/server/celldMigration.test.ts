import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeUniversalKey } from "./doDispatch.js";
import {
  legacyWorkerdObjectHash,
  migrateLegacyWorkerdStorage,
  type CellImporter,
} from "./celldMigration.js";
import { createHash } from "node:crypto";

const UNIVERSAL_KEY = "vibestudio-universal-do";
const INTERNAL = "vibestudio/internal";
const internalKey = (className: string) =>
  createHash("sha256").update(JSON.stringify([INTERNAL, className])).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The workerd layout the retired runtime left under the state directory. */
function legacyLayout(options: {
  workspaceId: string;
  entities: Array<{ source: string; className: string; key: string }>;
  userland: Array<{ source: string; className: string; objectKey: string; facet: boolean }>;
  product?: Array<{ className: string; objectKey: string }>;
  orphans?: number;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-legacy-"));
  roots.push(root);
  const layout = {
    legacyWorkerdDoDir: path.join(root, "workerd-do"),
    legacyWorkerdUniversalDoDir: path.join(root, "workerd-universal-do"),
  };
  const touch = (file: string, body = "x") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The workspace's own database is already there, with its records.
    if (!fs.existsSync(file)) fs.writeFileSync(file, body);
  };
  // The workspace's own database lists its entities.
  const workspaceDir = path.join(layout.legacyWorkerdDoDir, internalKey("WorkspaceDO"));
  fs.mkdirSync(workspaceDir, { recursive: true });
  const database = new DatabaseSync(
    path.join(workspaceDir, `${legacyWorkerdObjectHash(internalKey("WorkspaceDO"), options.workspaceId)}.sqlite`)
  );
  database.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_repo_path TEXT NOT NULL, class_name TEXT, key TEXT NOT NULL)`);
  const insert = database.prepare(
    `INSERT INTO entities (id, kind, source_repo_path, class_name, key) VALUES (?, ?, ?, ?, ?)`
  );
  options.entities.forEach((entity, index) =>
    insert.run(`e${index}`, "do", entity.source, entity.className, entity.key)
  );
  insert.run("w", "worker", "workers/ignored", null, "not-a-do");
  database.close();
  for (const item of options.userland) {
    const hash = legacyWorkerdObjectHash(UNIVERSAL_KEY, encodeUniversalKey(item));
    const dir = path.join(layout.legacyWorkerdUniversalDoDir, UNIVERSAL_KEY);
    touch(path.join(dir, `${hash}.sqlite`));
    if (item.facet) touch(path.join(dir, `${hash}.1.sqlite`));
  }
  for (const item of options.product ?? []) {
    const key = internalKey(item.className);
    touch(
      path.join(layout.legacyWorkerdDoDir, key, `${legacyWorkerdObjectHash(key, item.objectKey)}.sqlite`)
    );
  }
  for (let index = 0; index < (options.orphans ?? 0); index++) {
    touch(
      path.join(layout.legacyWorkerdUniversalDoDir, UNIVERSAL_KEY, `${createHash("sha256").update(`orphan${index}`).digest("hex")}.sqlite`)
    );
  }
  return { root, layout, stateDir: path.join(root, "celld") };
}

function recorder(existing: Set<string> = new Set()) {
  const calls: Array<Parameters<CellImporter["importCell"]>[0]> = [];
  const importer: CellImporter = {
    async importCell(input) {
      calls.push(input);
      const identity = `${input.className}/${input.name}`;
      if (existing.has(identity)) return "exists";
      existing.add(identity);
      return "imported";
    },
  };
  return { calls, importer, existing };
}

describe("legacy workerd storage migration", () => {
  const classes = ["WorkspaceDO", "BrowserVaultDO", "EvalDO", "WebhookStoreDO"];

  it("names objects from the workspace's records and maps them to cells", async () => {
    const userland = { source: "workers/agent", className: "Agent", objectKey: "a/1" };
    const fixture = legacyLayout({
      workspaceId: "ws-1",
      entities: [
        { source: userland.source, className: userland.className, key: userland.objectKey },
        { source: "workers/board", className: "Board", key: "no-facet" },
        { source: INTERNAL, className: "BrowserVaultDO", key: "vault-1" },
      ],
      userland: [
        { ...userland, facet: true },
        { source: "workers/board", className: "Board", objectKey: "no-facet", facet: false },
      ],
      product: [
        { className: "WorkspaceDO", objectKey: "ws-1" },
        { className: "BrowserVaultDO", objectKey: "vault-1" },
      ],
      orphans: 2,
    });
    const { calls, importer } = recorder();
    const report = await migrateLegacyWorkerdStorage({
      layout: fixture.layout,
      stateDir: fixture.stateDir,
      workspaceId: "ws-1",
      internalClasses: classes,
      importer,
    });
    expect(report.state).toBe("migrated");
    const byName = new Map(calls.map((call) => [`${call.className}/${call.name}`, call]));
    // A product object is the cell `objectKey` of its class, without facets.
    expect(byName.get("WorkspaceDO/ws-1")).toMatchObject({ script: "vibestudio", className: "WorkspaceDO" });
    expect(byName.get("WorkspaceDO/ws-1")?.facets).toBeUndefined();
    expect(byName.get("BrowserVaultDO/vault-1")).toBeDefined();
    // A userland object is the UniversalDO cell of its encoded key; its second
    // database is the facet `do`.
    const withFacet = byName.get(`UniversalDO/${encodeUniversalKey(userland)}`)!;
    expect(withFacet.root.endsWith(".sqlite")).toBe(true);
    expect(withFacet.facets).toEqual({ do: withFacet.root.replace(/\.sqlite$/u, ".1.sqlite") });
    const noFacet = byName.get(
      `UniversalDO/${encodeUniversalKey({ source: "workers/board", className: "Board", objectKey: "no-facet" })}`
    )!;
    expect(noFacet.facets).toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(report.imported).toHaveLength(4);
    // Files no record names are reported and left alone.
    expect(report.unmapped).toEqual([
      expect.objectContaining({ directory: expect.stringContaining("workerd-universal-do"), files: 2 }),
    ]);
    // Nothing is deleted: the legacy files are the user's until they say otherwise.
    expect(
      fs.readdirSync(path.join(fixture.layout.legacyWorkerdUniversalDoDir, UNIVERSAL_KEY))
    ).toHaveLength(5);
  });

  it("runs once: a completed migration is recorded and not repeated", async () => {
    const fixture = legacyLayout({
      workspaceId: "ws-1",
      entities: [],
      userland: [],
      product: [{ className: "WorkspaceDO", objectKey: "ws-1" }],
    });
    const first = recorder();
    expect(
      (
        await migrateLegacyWorkerdStorage({
          layout: fixture.layout,
          stateDir: fixture.stateDir,
          workspaceId: "ws-1",
          internalClasses: classes,
          importer: first.importer,
        })
      ).state
    ).toBe("migrated");
    const second = recorder();
    const again = await migrateLegacyWorkerdStorage({
      layout: fixture.layout,
      stateDir: fixture.stateDir,
      workspaceId: "ws-1",
      internalClasses: classes,
      importer: second.importer,
    });
    expect(again.state).toBe("already-complete");
    expect(second.calls).toEqual([]);
  });

  it("does nothing when there is no legacy storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-legacy-none-"));
    roots.push(root);
    const { calls, importer } = recorder();
    const report = await migrateLegacyWorkerdStorage({
      layout: {
        legacyWorkerdDoDir: path.join(root, "workerd-do"),
        legacyWorkerdUniversalDoDir: path.join(root, "workerd-universal-do"),
      },
      stateDir: path.join(root, "celld"),
      workspaceId: "ws-1",
      internalClasses: classes,
      importer,
    });
    expect(report).toMatchObject({ state: "none" });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(root, "celld"))).toBe(false);
  });

  it("is idempotent per object: an interrupted run resumes and cells that exist are left alone", async () => {
    const fixture = legacyLayout({
      workspaceId: "ws-1",
      entities: [{ source: "workers/a", className: "A", key: "k" }],
      userland: [{ source: "workers/a", className: "A", objectKey: "k", facet: true }],
      product: [{ className: "WorkspaceDO", objectKey: "ws-1" }],
    });
    // The first run imports the workspace, then fails on the userland object.
    const interrupted = new Set<string>();
    const failing: CellImporter = {
      async importCell(input) {
        if (input.className === "UniversalDO") throw new Error("disk full");
        interrupted.add(`${input.className}/${input.name}`);
        return "imported";
      },
    };
    await expect(
      migrateLegacyWorkerdStorage({
        layout: fixture.layout,
        stateDir: fixture.stateDir,
        workspaceId: "ws-1",
        internalClasses: classes,
        importer: failing,
      })
    ).rejects.toThrow("disk full");
    // No marker: the next start tries again, and the workspace cell is "exists".
    expect(fs.existsSync(path.join(fixture.stateDir, "legacy-migration.json"))).toBe(false);
    const resumed = recorder(interrupted);
    const report = await migrateLegacyWorkerdStorage({
      layout: fixture.layout,
      stateDir: fixture.stateDir,
      workspaceId: "ws-1",
      internalClasses: classes,
      importer: resumed.importer,
    });
    expect(report.state).toBe("migrated");
    expect(report.existing.map((entry) => entry.cell)).toEqual(["WorkspaceDO"]);
    expect(report.imported.map((entry) => entry.cell)).toEqual(["UniversalDO"]);
  });

  it("derives workerd's object hashes as workerd does", () => {
    // Verified against files a real workerd wrote for idFromName("alpha") and
    // idFromName("beta") in the namespace `vibestudio-universal-do`.
    expect(legacyWorkerdObjectHash(UNIVERSAL_KEY, "alpha")).toBe(
      "df53f226ea5808e68e221741fdf7d01cd84572390f93afccb3342382390e58a1"
    );
    expect(legacyWorkerdObjectHash(UNIVERSAL_KEY, "beta")).toBe(
      "c570d5e2f4692d41a77459cfb6987c219b33426ea5ebf525e203d72379314e44"
    );
  });
});

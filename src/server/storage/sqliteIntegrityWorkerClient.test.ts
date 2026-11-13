import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSqliteIntegrityWorkerEntry,
  SqliteIntegrityWorkerClient,
} from "./sqliteIntegrityWorkerClient.js";

const roots: string[] = [];
const clients: SqliteIntegrityWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("SqliteIntegrityWorkerClient", () => {
  it("resolves the compiled generation worker", () => {
    expect(resolveSqliteIntegrityWorkerEntry()).toBe(
      path.join(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "sqlite-integrity-worker.mjs")
    );
  });

  it("checks a database without occupying the server event loop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-worker-"));
    roots.push(root);
    const databasePath = path.join(root, "state.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO records (value) VALUES (?)");
    database.exec("BEGIN");
    for (let index = 0; index < 5_000; index += 1) insert.run(`record-${index}`);
    database.exec("COMMIT");
    database.close();

    const client = new SqliteIntegrityWorkerClient();
    clients.push(client);
    let timerAdvanced = false;
    setTimeout(() => {
      timerAdvanced = true;
    }, 0);
    await client.verify([databasePath]);

    expect(timerAdvanced).toBe(true);
  });

  it("verifies writable Durable Object databases beyond the Windows path limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-worker-"));
    roots.push(root);
    const directory = path.join(
      root,
      ...Array.from({ length: 5 }, () => "durable-object-storage-".repeat(2))
    );
    fs.mkdirSync(directory, { recursive: true });
    const databasePath = path.join(directory, "facet.sqlite");
    expect(databasePath.length).toBeGreaterThan(260);
    const database = new DatabaseSync(path.toNamespacedPath(databasePath));
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    database.close();
    const client = new SqliteIntegrityWorkerClient();
    clients.push(client);
    await client.verify([databasePath], { readOnly: false });
    await client.verify([databasePath]);
    const persisted = new DatabaseSync(path.toNamespacedPath(databasePath), { readOnly: true });
    try {
      expect(persisted.prepare("SELECT COUNT(*) AS count FROM records").get()).toMatchObject({
        count: 0,
      });
    } finally {
      persisted.close();
    }
  });

  it("names the damaged database and its integrity problems", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-worker-"));
    roots.push(root);
    const databasePath = path.join(root, "damaged.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX by_value ON records(value)"
    );
    const insert = database.prepare("INSERT INTO records (value) VALUES (?)");
    for (let index = 0; index < 200; index += 1) insert.run(`value-${index}`);
    database.close();
    // Change one stored value without its index entry.
    const bytes = fs.readFileSync(databasePath);
    bytes[bytes.indexOf("value-123")] = "V".charCodeAt(0);
    fs.writeFileSync(databasePath, bytes);

    const client = new SqliteIntegrityWorkerClient();
    clients.push(client);
    const failure = await client.verify([databasePath]).then(
      () => null,
      (error: Error) => error
    );
    expect(failure?.message).toContain(`${databasePath} failed SQLite integrity_check:`);
    expect(failure?.message).toContain("missing from index by_value");
  });

  it("names a database that cannot be opened", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-worker-"));
    roots.push(root);
    const databasePath = path.join(root, "garbage.sqlite");
    fs.writeFileSync(databasePath, Buffer.alloc(8192, 0xff));
    const client = new SqliteIntegrityWorkerClient();
    clients.push(client);
    await expect(client.verify([databasePath])).rejects.toThrow(
      `${databasePath} failed SQLite verification:`
    );
  });
});

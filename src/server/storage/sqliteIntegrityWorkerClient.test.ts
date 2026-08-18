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
  it("resolves the source-mode worker bootstrap", () => {
    expect(resolveSqliteIntegrityWorkerEntry(process.cwd())).toBe(
      path.join(process.cwd(), "src/server/storage/sqliteIntegrityWorkerBootstrap.mjs")
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

    const client = new SqliteIntegrityWorkerClient(process.cwd());
    clients.push(client);
    let timerAdvanced = false;
    setTimeout(() => {
      timerAdvanced = true;
    }, 0);
    await client.verify([databasePath]);

    expect(timerAdvanced).toBe(true);
  });
});

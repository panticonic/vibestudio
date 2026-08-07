import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import { installDurableObjectSchema, type DurableObjectSchemaDefinition } from "./schema.js";

type Sql = Awaited<ReturnType<typeof createInMemorySql>>;

function definition(sql: Sql, version: 1 | 2): DurableObjectSchemaDefinition {
  return {
    className: "ReferenceBoardDO",
    version,
    productionBaseline: { version: 1, name: "reference-board-v1" },
    storage: { sql, transactionSync: (callback) => sql.transactionSync(callback) },
    schemaTables: ["boards", "cards"],
    migrations:
      version === 2
        ? [
            {
              version: 2,
              name: "normalize-board-metadata-and-archive-state",
              validateSource: (source) => {
                const columns = source
                  .exec(`PRAGMA table_info(cards)`)
                  .toArray()
                  .map((row) => row["name"]);
                if (columns.join(",") !== "id,board_id,title,label") {
                  throw new Error("cards is not the captured v1 shape");
                }
                const indexes = source
                  .exec(`PRAGMA index_list(cards)`)
                  .toArray()
                  .map((row) => row["name"]);
                if (!indexes.includes("cards_board_idx")) {
                  throw new Error("captured v1 index is missing");
                }
              },
              migrate: (target) => {
                target.exec(
                  `ALTER TABLE boards ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`
                );
                target.exec(`
                  CREATE TABLE cards_v2 (
                    id TEXT PRIMARY KEY,
                    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    label TEXT NOT NULL,
                    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
                  )
                `);
                target.exec(`
                  INSERT INTO cards_v2 (id, board_id, title, label, archived)
                  SELECT id, board_id,
                         CASE WHEN title LIKE '[archived] %' THEN substr(title, 12) ELSE title END,
                         label,
                         CASE WHEN title LIKE '[archived] %' THEN 1 ELSE 0 END
                  FROM cards
                `);
                target.exec(`DROP TABLE cards`);
                target.exec(`ALTER TABLE cards_v2 RENAME TO cards`);
                target.exec(`CREATE INDEX cards_board_idx ON cards(board_id)`);
              },
            },
          ]
        : [],
    createSchema: () => {
      sql.exec(
        version === 1
          ? `CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL)`
          : `CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}')`
      );
      sql.exec(
        version === 1
          ? `CREATE TABLE cards (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, label TEXT NOT NULL)`
          : `CREATE TABLE cards (
               id TEXT PRIMARY KEY,
               board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
               title TEXT NOT NULL,
               label TEXT NOT NULL,
               archived INTEGER NOT NULL CHECK (archived IN (0, 1))
             )`
      );
      sql.exec(`CREATE INDEX cards_board_idx ON cards(board_id)`);
    },
    validateSchema: () => {
      const columns = sql
        .exec(`PRAGMA table_info(cards)`)
        .toArray()
        .map((row) => row["name"]);
      const expected =
        version === 1 ? "id,board_id,title,label" : "id,board_id,title,label,archived";
      if (columns.join(",") !== expected) throw new Error("cards shape is invalid");
      if (
        !sql
          .exec(`PRAGMA index_list(cards)`)
          .toArray()
          .some((row) => row["name"] === "cards_board_idx")
      ) {
        throw new Error("cards_board_idx is missing");
      }
      if (version === 2 && sql.exec(`PRAGMA foreign_key_list(cards)`).toArray().length !== 1) {
        throw new Error("cards foreign key is missing");
      }
    },
  };
}

function replaceCards(
  sql: Sql,
  boardId: string,
  cards: Array<{ id: string; title: string; label: string; archived: boolean }>
): void {
  if (!cards.every((card) => card.id && card.title && card.label)) {
    throw new Error("replacement payload is incomplete");
  }
  sql.transactionSync(() => {
    sql.exec(`DELETE FROM cards WHERE board_id = ?`, boardId);
    for (const card of cards) {
      sql.exec(
        `INSERT INTO cards (id, board_id, title, label, archived) VALUES (?, ?, ?, ?, ?)`,
        card.id,
        boardId,
        card.title,
        card.label,
        card.archived ? 1 : 0
      );
    }
  });
}

describe("repository-owned Durable Object migration fixture", () => {
  it("normalizes representative v1 rows and makes replacement mutations atomic", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema(definition(sql, 1));
    sql.exec(`INSERT INTO boards (id, title) VALUES ('b1', 'Roadmap')`);
    sql.exec(
      `INSERT INTO cards (id, board_id, title, label) VALUES ('c1', 'b1', '[archived] shipped', 'done')`
    );

    installDurableObjectSchema(definition(sql, 2));
    expect(sql.exec(`SELECT title, archived FROM cards WHERE id = 'c1'`).one()).toEqual({
      title: "shipped",
      archived: 1,
    });
    expect(
      sql.exec(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`).toArray()
    ).toEqual([{ version: 2, name: "normalize-board-metadata-and-archive-state" }]);

    expect(() =>
      replaceCards(sql, "b1", [{ id: "", title: "invalid", label: "todo", archived: false }])
    ).toThrow("replacement payload is incomplete");
    expect(sql.exec(`SELECT id FROM cards WHERE board_id = 'b1'`).toArray()).toEqual([
      { id: "c1" },
    ]);
  });
});

import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";
import { createCredentialClient } from "@vibestudio/credential-client";
import { z } from "zod";
const pathSchema = z
  .string()
  .regex(/^\/(?:overview|analytics|reports(?:\/[a-f0-9-]{36}(?:\/bundle)?)?|sql)(?:\?[^#]*)?$/);
/** This stores connection references and saved queries, never mirrors the remote error database. */
export class ErrorReportsDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec("CREATE TABLE connections (owner TEXT PRIMARY KEY, credential_id TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE saved_queries (owner TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,sql TEXT NOT NULL,params TEXT NOT NULL,PRIMARY KEY(owner,id))"
    );
  }
  protected requiredTables(): readonly string[] {
    return ["connections", "saved_queries"];
  }
  private owner(): string {
    const owner = this.caller?.userId;
    if (!owner || owner === "system") throw new Error("Authenticated developer required");
    return owner;
  }
  @rpc({
    website: { kind: "closed", reason: "Developer reporting connection." },
    principals: ["user", "host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  configure(credentialId: string): void {
    const owner = this.owner();
    z.string().min(1).max(256).parse(credentialId);
    this.sql.exec(
      "INSERT INTO connections VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET credential_id=excluded.credential_id",
      owner,
      credentialId
    );
  }
  @rpc({
    website: { kind: "closed", reason: "Private developer report data." },
    principals: ["user", "host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async read(path: string): Promise<unknown> {
    if (path.split("?")[0] === "/sql") throw new Error("SQL uses its administrative operation");
    return this.request("GET", path);
  }
  @rpc({
    website: { kind: "closed", reason: "Administrative developer SQL." },
    principals: ["user", "host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async sqlQuery(sql: string, params: (string | number | null)[] = []): Promise<unknown> {
    z.string().min(1).parse(sql);
    return this.request("POST", "/sql", { sql, params });
  }
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    pathSchema.parse(path);
    const connection = this.sql
      .exec("SELECT credential_id FROM connections WHERE owner=?", this.owner())
      .toArray()[0];
    if (!connection)
      throw new Error("Connect a developer credential through secure host input first");
    const response = await createCredentialClient(this.rpc).fetch(
      `https://vibestudio.app/v1/problem-reports/admin${path}`,
      {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
      { credentialId: String(connection["credential_id"]) }
    );
    if (!response.ok) throw new Error(`Report service returned HTTP ${response.status}`);
    return response.json();
  }
  @rpc({
    website: { kind: "closed", reason: "Private saved developer queries." },
    principals: ["user", "host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  saveQuery(input: {
    id: string;
    title: string;
    sql: string;
    params: (string | number | null)[];
  }): void {
    const value = z
      .object({
        id: z.string().uuid(),
        title: z.string().max(128),
        sql: z.string().min(1),
        params: z.array(z.union([z.string(), z.number().finite(), z.null()])),
      })
      .strict()
      .parse(input);
    this.sql.exec(
      "INSERT INTO saved_queries VALUES (?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET title=excluded.title,sql=excluded.sql,params=excluded.params",
      this.owner(),
      value.id,
      value.title,
      value.sql,
      JSON.stringify(value.params)
    );
  }
  @rpc({
    website: { kind: "closed", reason: "Private saved developer queries." },
    principals: ["user", "host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  savedQueries(): { id: string; title: string; sql: string; params: (string | number | null)[] }[] {
    return this.sql
      .exec(
        "SELECT id,title,sql,params FROM saved_queries WHERE owner=? ORDER BY title",
        this.owner()
      )
      .toArray()
      .map((row) => ({
        id: String(row["id"]),
        title: String(row["title"]),
        sql: String(row["sql"]),
        params: JSON.parse(String(row["params"])),
      }));
  }
}

import { describe, expect, it, vi } from "vitest";
import { DurableObjectBase } from "./index.js";
import { createTestDO } from "./test-utils.js";

// Export identity remains stable when the bundle changes constructor labels.
class RenamedImplementation extends DurableObjectBase {
  static override readonly durableWorkQueues = ["channel-delivery"] as const;
  protected createTables(): void {
    this.sql.exec("CREATE TABLE domain_items (id TEXT PRIMARY KEY)");
  }
  ready(): Promise<void> {
    return this.initializeSchema();
  }
}
class AnotherImplementationLabel extends RenamedImplementation {}
class ComposedOwner extends RenamedImplementation {
  protected override createTables():void {
    super.createTables();
    this.sql.exec("CREATE TABLE other_items (id TEXT PRIMARY KEY)");
  }
  protected override requiredTables():readonly string[] { return ["other_items","domain_items","other_items"]; }
  validateForTest():void { this.validateSchema(); }
}

async function probeDescriptor() {
  const probe = await createTestDO(
    RenamedImplementation,
    { WORKER_CLASS_NAME: "ExportedOwner", VIBESTUDIO_SCHEMA_PROBE: true },
    { initialize: false }
  );
  try {
    const response = await probe.instance.fetch(
      new Request("http://test/test-key/__vibestudio_schema_descriptor")
    );
    expect(response.ok).toBe(true);
    return (await response.json()) as {
      className: string;
      version: number;
      freshSchemaFingerprint: string;
      durableWorkQueues: readonly ["channel-delivery"];
    };
  } finally {
    probe.db.close();
  }
}

describe("host-loaded Durable Object schema identity", () => {
  it("checks all composed tables in one catalog read while preserving exact missing-table diagnostics", async () => {
    const owner=await createTestDO(ComposedOwner);
    const reads=vi.spyOn(owner.sql,"exec");
    try {
      owner.instance.validateForTest();
      expect(reads.mock.calls.filter(([query])=>query.includes("sqlite_master"))).toHaveLength(1);
      owner.sql.exec("DROP TABLE domain_items");
      owner.sql.exec("DROP TABLE other_items");
      reads.mockClear();
      expect(()=>owner.instance.validateForTest()).toThrow("missing table(s): other_items, domain_items, other_items");
      expect(reads.mock.calls.filter(([query])=>query.includes("sqlite_master"))).toHaveLength(1);
    } finally { reads.mockRestore();owner.db.close(); }
  });
  it("probes and reopens the same exported owner across changed constructor labels", async () => {
    const descriptor = await probeDescriptor();
    expect(descriptor.className).toBe("ExportedOwner");
    expect(descriptor.durableWorkQueues).toEqual(["channel-delivery"]);
    const env = {
      WORKER_CLASS_NAME: "ExportedOwner",
      VIBESTUDIO_SCHEMA_DESCRIPTOR: descriptor,
    };
    const first = await createTestDO(RenamedImplementation, env);
    try {
      first.sql.exec("INSERT INTO domain_items VALUES ('retained')");
      const reopened = await createTestDO(AnotherImplementationLabel, env, { db: first.db });
      expect(reopened.sql.exec("SELECT * FROM domain_items").toArray()).toEqual([
        { id: "retained" },
      ]);
    } finally {
      first.db.close();
    }
  });

  it("refuses a descriptor for another export before creating domain state", async () => {
    const descriptor = await probeDescriptor();
    const fixture = await createTestDO(
      RenamedImplementation,
      {
        WORKER_CLASS_NAME: "OtherOwner",
        VIBESTUDIO_SCHEMA_DESCRIPTOR: descriptor,
      },
      { initialize: false }
    );
    try {
      await expect(fixture.instance.ready()).rejects.toThrow(
        "Schema descriptor does not match the admitted runtime image"
      );
      expect(fixture.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });

  it("refuses altered or absent executable capabilities before creating domain state", async () => {
    const descriptor = await probeDescriptor();
    for (const queues of [[], undefined, ["workspace-publication"]]) {
      const fixture = await createTestDO(
        RenamedImplementation,
        {
          WORKER_CLASS_NAME: "ExportedOwner",
          VIBESTUDIO_SCHEMA_DESCRIPTOR: { ...descriptor, durableWorkQueues: queues },
        },
        { initialize: false }
      );
      try {
        await expect(fixture.instance.ready()).rejects.toThrow();
        expect(fixture.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
      } finally {
        fixture.db.close();
      }
    }
  });

  it("refuses a missing host class binding instead of deriving constructor identity", async () => {
    const fixture = await createTestDO(
      RenamedImplementation,
      { WORKER_CLASS_NAME: undefined },
      { initialize: false }
    );
    try {
      await expect(fixture.instance.ready()).rejects.toThrow("exact host-loaded class binding");
      expect(fixture.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });
});

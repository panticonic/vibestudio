import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  celldTestBinary,
  startCelldProbe,
  type CelldProbe,
} from "../../tests/helpers/celldNodeHarness.js";
import { putBlobBytes } from "./storage/blobCas.js";
import {
  retainedBlobDigests,
  retainBlob,
  releaseBlobRetentionNamespace,
} from "./storage/blobRetentions.js";

async function withProbe(operation: (root: string, probe: CelldProbe) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "retention-interop-"));
  let probe: CelldProbe | undefined;
  try {
    probe = await startCelldProbe({
      root,
      classes: [],
      doltClasses: ["Probe"],
      bundle: `
        export class Probe {
          constructor(ctx) {
            this.ctx = ctx;
            ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY)');
          }
          async fetch(request) {
            if (request.method === 'POST') {
              this.ctx.storage.sql.exec('INSERT INTO notes VALUES (?)', Number(await request.text()));
              this.ctx.storage.dolt.commit({message: 'native retention interop'});
            }
            return Response.json({rows: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM notes').toArray()[0].n});
          }
        }
        export default {fetch(request, env) {
          return env.PROBE.get(env.PROBE.idFromName('one')).fetch(request);
        }};
      `,
    });
    await probe.start();
    await operation(root, probe);
  } finally {
    await probe?.kill();
    await rm(root, { recursive: true, force: true });
  }
}

it.skipIf(!celldTestBinary())(
  "reads committed retention roots while another writer owns a transaction",
  async () => {
    await withProbe(async (root, probe) => {
      const blobs = join(root, "blobs");
      const stored = await putBlobBytes(blobs, Buffer.from("protected blob"));
      retainBlob(blobs, "host-test", "owner", stored.digest);
      await probe.stop();
      const writer = new DatabaseSync(join(blobs, "retentions.db"));
      try {
        writer.exec("BEGIN EXCLUSIVE");
        expect(retainedBlobDigests(blobs)).toContain(stored.digest);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    });
  }
);

it.skipIf(!celldTestBinary())(
  "joins native writes and host retention mutations without losing durable rows",
  async () => {
    await withProbe(async (root, probe) => {
      const blobs = join(root, "blobs");
      const stored = await putBlobBytes(blobs, Buffer.from("host-owned content"));
      retainBlob(blobs, "host-fixture", "owner", stored.digest);
      const fixture = new DatabaseSync(join(blobs, "retentions.db"));
      try {
        fixture.exec("BEGIN IMMEDIATE");
        const insert = fixture.prepare("INSERT INTO blob_retentions VALUES (?, ?, ?)");
        for (let n = 0; n < 1000; n++) {
          insert.run("host-fixture", `owner-${n}-${"x".repeat(800)}`, stored.digest);
        }
        fixture.exec("COMMIT");
      } finally {
        fixture.close();
      }
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(new Error("Interop investigation deadline")),
        60_000
      );
      let completed = false;
      const failures: unknown[] = [];
      const writer = (async () => {
        for (let turn = 0; turn < 65; turn++) {
          const response = await fetch(probe.endpoint, {
            method: "POST",
            body: String(turn),
            signal: controller.signal,
          });
          expect(response.ok).toBe(true);
          expect(await response.json()).toEqual({ rows: turn + 1 });
        }
      })()
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => {
          completed = true;
        });
      try {
        let checks = 0;
        while ((!completed || checks < 200) && checks < 2000) {
          controller.signal.throwIfAborted();
          retainBlob(blobs, "host-interleaved", "owner", stored.digest);
          releaseBlobRetentionNamespace(blobs, "host-interleaved");
          checks++;
          await delay(1, undefined, { signal: controller.signal });
        }
        await writer;
        expect(failures).toEqual([]);
        expect(checks).toBeGreaterThanOrEqual(200);
        // HTTP replies can precede publication. Join the normal durable shutdown
        // and restore before asserting the native writes survived.
        await probe.stop();
        expect(retainedBlobDigests(blobs)).toContain(stored.digest);
        await probe.start();
        const restored = await fetch(probe.endpoint, { signal: controller.signal });
        expect(restored.ok).toBe(true);
        expect(await restored.json()).toEqual({ rows: 65 });
      } finally {
        controller.abort(new Error("Interop owner retired"));
        clearTimeout(deadline);
        await writer;
      }
    });
  },
  90_000
);

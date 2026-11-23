/**
 * P0 of the Dolt redesign on the real fork: a Dolt root class built on the
 * real `DurableObjectBase` installs its schema (committed by F2), writes
 * through `committedTransaction`, and keeps its history across a process kill
 * and restart. Skipped without a celld binary (`VIBESTUDIO_CELLD_BIN`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { createInMemorySql } from "../../packages/durable/src/test-utils.js";
import {
  durableObjectSchemaFingerprint,
  installDurableObjectSchema,
} from "../../packages/durable/src/schema.js";
import { doltLocalPatterns } from "../../packages/durable/src/dolt.js";
import {
  celldTestBinary,
  startCelldProbe,
  type CelldProbe,
} from "../../tests/helpers/celldNodeHarness.js";

const LOCAL_PATTERNS = doltLocalPatterns(["local_%"]);

// The class's schema, written the way a class writes it (spaces before
// parentheses). Dolt renders `sqlite_master.sql` itself, in its own form.
const NOTES_V1 =
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL DEFAULT 'x' CHECK (length(body) < 100))";
const NOTES_V2 =
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL DEFAULT 'x' CHECK (length(body) < 100), tag TEXT)";
const NOTES_INDEX = "CREATE INDEX notes_body ON notes (body)";
const MARKS = "CREATE TABLE local_marks (id INTEGER PRIMARY KEY, note TEXT)";

/** The probe class at one schema version. v2 adds a column through an admitted upgrade. */
function probeSource(version: 1 | 2, v1Fingerprint?: string): string {
  return `
    import { DurableObjectBase } from '@vibestudio/durable';
    import { assertCleanWorkingSet, committedTransaction } from '@vibestudio/durable/dolt';
    import { durableObjectSchemaFingerprint } from '@vibestudio/durable/schema';
    const TABLES = ['notes', 'local_marks'];
    export class Probe extends DurableObjectBase {
      static schemaVersion = ${version};
      createTables() {
        this.sql.exec(${JSON.stringify(version === 2 ? NOTES_V2 : NOTES_V1)});
        this.sql.exec(${JSON.stringify(NOTES_INDEX)});
        this.sql.exec(${JSON.stringify(MARKS)});
      }
      requiredTables() { return TABLES; }
      schemaIndexDefinitions() { return [${JSON.stringify(NOTES_INDEX)}]; }
      schemaUpgrades() {
        return ${
          version === 2
            ? `[{ fromVersion: 1, fromFingerprint: ${JSON.stringify(v1Fingerprint)}, upgrade: () => { this.sql.exec('ALTER TABLE notes ADD COLUMN tag TEXT'); } }]`
            : "[]"
        };
      }
      async fetch(request) {
        const url = new URL(request.url);
        const dolt = this.ctx.storage.dolt;
        const q = (name) => url.searchParams.get(name) ?? '';
        let extra = {};
        if (url.pathname === '/raw-master') {
          return Response.json({
            master: this.sql.exec('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').toArray(),
            shape: this.sql.exec('SELECT shape_json FROM _vibestudio_schema').toArray(),
          });
        }
        await this.initializeSchema();
        switch (url.pathname) {
          case '/install': break;
          case '/add': {
            const id = this.committedTransaction(
              (result) => 'add note ' + result,
              () => {
                if (q('id')) this.sql.exec('INSERT INTO notes(id, body) VALUES (?, ?)', Number(q('id')), q('body'));
                else this.sql.exec('INSERT INTO notes(body) VALUES (?)', q('body'));
                return this.sql.exec('SELECT max(id) AS id FROM notes').one().id;
              });
            extra = { added: id };
            break;
          }
          case '/edit': {
            this.committedTransaction(
              () => 'edit note ' + q('id'),
              () => { this.sql.exec('UPDATE notes SET body = ? WHERE id = ?', q('body'), Number(q('id'))); });
            break;
          }
          case '/merge-resolve': {
            // F1: resolve every conflict inside the merge's own transaction.
            const result = dolt.merge(q('branch'), {
              message: 'merge ' + q('branch'),
              resolve(merge) {
                for (const row of merge.conflicts) {
                  if (q('take') === 'theirs') row.takeTheirs(); else row.keepOurs();
                }
              },
            });
            extra = { merged: result };
            break;
          }
          case '/fail': {
            try {
              this.committedTransaction('never', () => {
                this.sql.exec('INSERT INTO notes(body) VALUES (?)', 'doomed');
                throw new Error('callback failed');
              });
            } catch (error) { extra = { failed: String(error.message) }; break; }
            extra = { failed: null };
            break;
          }
          case '/skip': {
            this.committedTransaction(() => null, () => { this.sql.exec('INSERT INTO notes(body) VALUES (?)', 'skipped'); });
            break;
          }
          case '/slow': {
            // An async transaction that a kill interrupts after its write.
            await committedTransaction(this.ctx.storage, 'slow note', async () => {
              this.sql.exec('INSERT INTO notes(body) VALUES (?)', 'slow');
              await new Promise((resolve) => setTimeout(resolve, 30000));
            });
            break;
          }
          case '/mark': this.sql.exec('INSERT INTO local_marks(note) VALUES (?)', q('note')); break;
          case '/dirty': this.sql.exec('INSERT INTO notes(body) VALUES (?)', q('body')); break;
          case '/state-write': this.setStateValue('k', 'v'); break;
          case '/commit': dolt.commit({ message: q('message') }); break;
          case '/dolt': {
            // Call any ctx.storage.dolt method: ?method=branch.create&args=["x"]
            const path = q('method').split('.');
            const target = path.slice(0, -1).reduce((value, key) => value[key], dolt);
            extra = { result: target[path[path.length - 1]](...JSON.parse(q('args') || '[]')) ?? null };
            break;
          }
          case '/reset-hard': dolt.reset({ hard: true, to: q('to') }); break;
          case '/assert-clean': {
            try { assertCleanWorkingSet(dolt); return Response.json({ clean: true }); }
            catch (error) { return Response.json({ clean: false, code: error.code, tables: error.tables }); }
          }
          case '/fingerprint':
            return Response.json({ fingerprint: durableObjectSchemaFingerprint(this.sql, TABLES) });
          default: break;
        }
        const rows = (sql) => this.sql.exec(sql).toArray();
        return Response.json({
          ...extra,
          dolt: typeof dolt,
          branch: dolt.branch.current(),
          log: dolt.log({ limit: 50 }).map((entry) => entry.message),
          master: rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
          status: dolt.status(),
          notes: rows('SELECT id, body FROM notes ORDER BY id'),
          marks: rows('SELECT id, note FROM local_marks ORDER BY id'),
          columns: rows('PRAGMA table_info(notes)').map((row) => row.name),
          schema: rows('SELECT version FROM _vibestudio_schema').map((row) => row.version),
          stateKeys: rows('SELECT key FROM state').map((row) => row.key),
        });
      }
    }
    export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName('one')).fetch(request); } };
  `;
}

async function bundleProbe(version: 1 | 2, v1Fingerprint?: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: probeSource(version, v1Fingerprint),
      resolveDir: process.cwd(),
      sourcefile: `dolt-durable-probe-v${version}.ts`,
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["worker", "browser"],
    external: ["node:*"],
    write: false,
    logLevel: "error",
  });
  const text = result.outputFiles[0]?.text;
  if (!text) throw new Error("Missing Dolt durable probe bundle");
  return text;
}

/** The fresh fingerprint a build trusts, computed the way the host's schema probe does (on SQLite). */
async function freshFingerprint(version: 1 | 2): Promise<string> {
  const sql = await createInMemorySql();
  await installDurableObjectSchema({
    className: "Probe",
    version: 1,
    storage: {
      sql,
      transaction: async (callback) => callback(),
    },
    schemaTables: ["notes", "local_marks"],
    createSchema: () => {
      sql.exec(version === 2 ? NOTES_V2 : NOTES_V1);
      sql.exec(NOTES_INDEX);
      sql.exec(MARKS);
    },
    validateSchema: () => undefined,
  });
  return durableObjectSchemaFingerprint(sql, ["notes", "local_marks"]);
}

interface ProbeInfo {
  dolt: string;
  branch: string;
  log: string[];
  master: string[];
  status: { table: string; staged: unknown; status: string }[];
  notes: { id: number; body: string }[];
  marks: { id: number; note: string }[];
  columns: string[];
  schema: number[];
  stateKeys: string[];
  clean?: boolean;
  code?: string;
}

interface Running {
  readonly probe: CelldProbe;
  call(path: string): Promise<ProbeInfo & Record<string, unknown>>;
  /** `ctx.storage.dolt.<method>(...args)` inside the probe object. */
  dolt(method: string, args?: unknown[]): Promise<ProbeInfo & Record<string, unknown>>;
}

/** A Dolt probe node with one object, cleaned up when the test finishes. */
async function startProbe(options: {
  bundle?: string;
  vars?: Record<string, unknown>;
}): Promise<Running> {
  const root = await mkdtemp(join(homedir(), ".dolt-durable-probe-"));
  const requests = new AbortController();
  const probe = await startCelldProbe({
    root,
    bundle: options.bundle ?? (await bundleProbe(1)),
    classes: [],
    doltClasses: ["Probe"],
    celld: { durable_objects: { Probe: { doltLocal: LOCAL_PATTERNS } } },
    vars: { WORKER_CLASS_NAME: "Probe", ...options.vars },
  });
  let cleaning: Promise<void> | undefined;
  onTestFinished(
    () =>
      (cleaning ??= (async () => {
        requests.abort(new Error("Dolt durable probe retired"));
        await probe.kill();
        await rm(root, { recursive: true, force: true });
      })())
  );
  await probe.start();
  const call = async (path: string) => {
    const response = await fetch(`${probe.endpoint}${path}`, { signal: requests.signal });
    if (!response.ok) throw new Error(`probe ${path} failed: ${await response.text()}`);
    return (await response.json()) as ProbeInfo & Record<string, unknown>;
  };
  return {
    probe,
    call,
    dolt: (method, args = []) =>
      call(`/dolt?method=${method}&args=${encodeURIComponent(JSON.stringify(args))}`),
  };
}

it.skipIf(!celldTestBinary())(
  "a Dolt root class installs its schema, commits through committedTransaction, and survives a kill and restart",
  async () => {
    const { probe, call, dolt } = await startProbe({});

    // 1. The install is a Dolt commit, and the schema guard ignores what celld
    //    and Dolt own in the same database (`dolt_ignore`, `_cf_*`): the
    //    fingerprint taken inside the creating transaction still matches the
    //    one read at every later activation (step 5 reopens the object).
    const installed = await call("/install");
    expect(installed.dolt).toBe("object");
    expect(installed.branch).toBe("main");
    expect(installed.log).toContain("schema: Probe v1");
    expect(installed.schema).toEqual([1]);
    expect(installed.master).toContain("dolt_ignore");
    // Everything the install wrote is committed: the working set is clean.
    expect(installed.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);

    // 2. committedTransaction: the writes and the commit are one step.
    expect((await call("/add?body=one")).log[0]).toBe("add note 1");
    const two = await call("/add?body=two");
    expect(two.log.slice(0, 3)).toEqual(["add note 2", "add note 1", "schema: Probe v1"]);
    expect(two.notes.map((note) => note.body)).toEqual(["one", "two"]);
    expect((await call("/assert-clean")).clean).toBe(true);

    // 3. A throwing callback leaves no rows and no commit; a commit function
    //    that returns null leaves the rows uncommitted by design, and the
    //    drift check sees them.
    expect((await call("/fail"))["failed"]).toBe("callback failed");
    const afterFail = await call("/install");
    expect(afterFail.notes.map((note) => note.body)).toEqual(["one", "two"]);
    expect(afterFail.log[0]).toBe("add note 2");
    await call("/skip");
    const drift = await call("/assert-clean");
    expect(drift).toMatchObject({ clean: false, code: "DOLT_UNCOMMITTED_DRIFT" });
    await call("/commit?message=keep%20skipped");
    expect((await call("/assert-clean")).clean).toBe(true);

    // 4. Local tables are not versioned: writes to them keep the working set
    //    clean, and a hard reset rewinds the versioned rows only. (The reset
    //    is made durable by a durable stop; see the canary below.)
    await call("/mark?note=a");
    await call("/state-write");
    expect((await call("/assert-clean")).clean).toBe(true);
    expect((await call("/install")).stateKeys).toContain("k");
    await call("/reset-hard?to=HEAD~1");
    await probe.stop();
    await probe.start();
    const afterReset = await call("/install");
    expect(afterReset.notes.map((note) => note.body)).toEqual(["one", "two"]);
    expect(afterReset.marks.map((mark) => mark.note)).toEqual(["a"]);
    expect(afterReset.stateKeys).toContain("k");

    // 5. A kill during an in-flight transaction (its write made, its commit
    //    not yet) leaves neither the row nor a commit: F2 has no window.
    const logBeforeCrash = (await call("/install")).log;
    const slow = fetch(`${probe.endpoint}/slow`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await probe.kill();
    await slow;
    await probe.start();
    const restarted = await call("/install");
    expect(restarted.log).toEqual(logBeforeCrash);
    expect(restarted.notes.map((note) => note.body)).toEqual(["one", "two"]);
    expect(restarted.branch).toBe("main");
    expect(restarted.marks.map((mark) => mark.note)).toEqual(["a"]);

    // 6. A process kill after acknowledged commits keeps every one of them,
    //    and the install is not committed again.
    await call("/add?body=three");
    await probe.kill();
    await probe.start();
    const afterKill = await call("/install");
    // (A rowid is not reused after a hard reset, so the id is not asserted.)
    expect(afterKill.log[0]).toMatch(/^add note \d+$/);
    expect(afterKill.log[1]).toBe(logBeforeCrash[0]);
    expect(afterKill.notes.map((note) => note.body)).toEqual(["one", "two", "three"]);
    expect(afterKill.log.filter((message) => message.startsWith("schema:"))).toEqual([
      "schema: Probe v1",
    ]);

    // 7. Branches and an F1 merge with a resolver survive a kill too: both
    //    sides edit row 1, the resolver takes theirs inside the merge.
    await dolt("branch.create", ["side"]);
    await dolt("checkout", ["side"]);
    await call("/add?id=100&body=side-note");
    await call("/edit?id=1&body=one-side");
    await dolt("checkout", ["main"]);
    await call("/edit?id=1&body=one-main");
    const merged = await call("/merge-resolve?branch=side&take=theirs");
    expect(merged["merged"]).toMatchObject({
      conflicts: [],
      fastForward: false,
      upToDate: false,
      resolved: { conflicts: 1, violations: 0 },
    });
    expect((await call("/install")).log[0]).toBe("merge side");
    await probe.kill();
    await probe.start();
    const afterMerge = await call("/install");
    expect(afterMerge.log[0]).toBe("merge side");
    expect(afterMerge.notes.find((note) => note.id === 1)?.body).toBe("one-side");
    expect(afterMerge.notes.map((note) => note.body)).toContain("side-note");

    // 8. An upgrade: uncommitted state is checkpointed first, then the
    //    migration is its own commit, and the data survives.
    await call("/dirty?body=pending");
    const v1Fingerprint = await freshFingerprint(1);
    const v2Fingerprint = await freshFingerprint(2);
    await probe.stop();
    await probe.redeploy(await bundleProbe(2, v1Fingerprint), {
      WORKER_CLASS_NAME: "Probe",
      VIBESTUDIO_SCHEMA_DESCRIPTOR: {
        className: "Probe",
        version: 2,
        freshSchemaFingerprint: v2Fingerprint,
        durableWorkQueues: [],
        nativeOwner: false,
      },
    });
    await probe.start();
    const upgraded = await call("/install");
    expect(upgraded.schema).toEqual([2]);
    expect(upgraded.columns).toContain("tag");
    expect(upgraded.log.slice(0, 3)).toEqual([
      "schema: Probe v1→v2",
      "schema: checkpoint before Probe v1→v2",
      "merge side",
    ]);
    expect(upgraded.notes.map((note) => note.body)).toContain("pending");
    expect(upgraded.notes.find((note) => note.id === 1)?.body).toBe("one-side");
    expect((await call("/assert-clean")).clean).toBe(true);
  },
  240_000
);

// Fixed in celld 9440c29: an acknowledged `dolt.reset({ hard: true, to })`
// survives a SIGKILL and restart (it was lost on fcc7268; this was an
// `it.fails` canary). Backup restore and GAD `discard` depend on it.
it.skipIf(!celldTestBinary())(
  "an acknowledged hard reset survives a kill",
  async () => {
    const { probe, call, dolt } = await startProbe({});
    await call("/add?body=one");
    await call("/add?body=two");
    await dolt("reset", [{ hard: true, to: "HEAD~1" }]);
    expect((await call("/install")).notes.map((note) => note.body)).toEqual(["one"]);
    await probe.kill();
    await probe.start();
    expect((await call("/install")).notes.map((note) => note.body)).toEqual(["one"]);
  },
  120_000
);

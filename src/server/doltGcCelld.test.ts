/**
 * Compaction of a Dolt cell on the real fork (docs/dolt-redesign.md §6.11.8): a class built on the real
 * `DurableObjectBase` is collected by the base itself, on the geometric schedule, after the commit that
 * made it due, at an idle point and never over uncommitted work; the file shrinks, the cell still reads
 * and writes, its history is intact, and a restart keeps the schedule. Skipped without a celld binary
 * (`VIBESTUDIO_CELLD_BIN`).
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { doltLocalPatterns } from "../../packages/durable/src/dolt.js";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const LOCAL_PATTERNS = doltLocalPatterns(["local_%"]);
const NOTES = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)";
const MARKS = "CREATE TABLE local_marks (id INTEGER PRIMARY KEY, note TEXT)";

/** A class with a small schedule: a collection after 6 commits, then after half again as many. */
function probeSource(policy: "default-small" | "never"): string {
  return `
    import { DurableObjectBase } from '@vibestudio/durable';
    const TABLES = ['notes', 'local_marks'];
    export class Probe extends DurableObjectBase {
      static schemaVersion = 1;
      createTables() {
        this.sql.exec(${JSON.stringify(NOTES)});
        this.sql.exec(${JSON.stringify(MARKS)});
      }
      requiredTables() { return TABLES; }
      schemaIndexDefinitions() { return []; }
      schemaUpgrades() { return []; }
      doltGcPolicy() { return ${policy === "never" ? "null" : "{ minCommits: 6, growth: 0.5 }"}; }
      async fetch(request) {
        const url = new URL(request.url);
        const dolt = this.ctx.storage.dolt;
        const q = (name) => url.searchParams.get(name) ?? '';
        await this.initializeSchema();
        switch (url.pathname) {
          case '/add': {
            // A turn, the way an agent's is: several plain transactions rewrite the same row (what a commit does
            // not keep is what a collection frees), and the last one commits.
            for (let w = 0; w < Number(q('writes')); w++)
              this.transactionSync(() => {
                this.sql.exec('INSERT OR REPLACE INTO notes(id, body) VALUES (?, ?)', Number(q('id')), q('n') + '.' + w + 'x'.repeat(Number(q('bytes'))));
              });
            this.committedTransaction(
              () => 'note ' + q('id'),
              () => {
                this.sql.exec('INSERT OR REPLACE INTO notes(id, body) VALUES (?, ?)', Number(q('id')), q('n') + 'x'.repeat(Number(q('bytes'))));
              });
            return Response.json({ ok: true });
          }
          case '/dirty': {
            // Uncommitted work: a transaction with no commit point.
            this.transactionSync(() => { this.sql.exec('INSERT OR REPLACE INTO notes(id, body) VALUES (?, ?)', 9999, 'pending'); });
            return Response.json({ ok: true });
          }
          case '/commit': { dolt.commit({ message: q('message') }); return Response.json({ ok: true }); }
          case '/mark': { this.sql.exec('INSERT INTO local_marks(note) VALUES (?)', q('note')); return Response.json({ ok: true }); }
          default: break;
        }
        const rows = (sql) => this.sql.exec(sql).toArray();
        return Response.json({
          commits: dolt.log({ limit: 10000 }).length,
          head: dolt.hashOf('HEAD'),
          gcHead: this.getStateValue('__dolt_gc_head'),
          gcCommits: this.getStateValue('__dolt_gc_commits'),
          notes: rows('SELECT id, length(body) AS bytes FROM notes ORDER BY id').map((row) => [row.id, row.bytes]),
          marks: rows('SELECT note FROM local_marks ORDER BY id').map((row) => row.note),
          status: dolt.status().filter((entry) => !entry.table.startsWith('dolt_')),
        });
      }
    }
    export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName('one')).fetch(request); } };
  `;
}

async function bundleProbe(policy: "default-small" | "never"): Promise<string> {
  const result = await build({
    stdin: {
      contents: probeSource(policy),
      resolveDir: process.cwd(),
      sourcefile: `dolt-gc-probe-${policy}.ts`,
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
  if (!text) throw new Error("Missing Dolt gc probe bundle");
  return text;
}

interface Info {
  commits: number;
  head: string;
  gcHead: string | null;
  gcCommits: string | null;
  notes: Array<[number, number]>;
  marks: string[];
  status: unknown[];
}

async function startProbe(policy: "default-small" | "never") {
  const root = await mkdtemp(join(homedir(), ".dolt-gc-probe-"));
  const requests = new AbortController();
  const probe = await startCelldProbe({
    root,
    bundle: await bundleProbe(policy),
    classes: [],
    doltClasses: ["Probe"],
    celld: { durable_objects: { Probe: { doltLocal: LOCAL_PATTERNS } } },
    vars: { WORKER_CLASS_NAME: "Probe" },
  });
  let cleaning: Promise<void> | undefined;
  onTestFinished(
    () =>
      (cleaning ??= (async () => {
        requests.abort(new Error("Dolt gc probe retired"));
        await probe.kill();
        await rm(root, { recursive: true, force: true });
      })())
  );
  await probe.start();
  const call = async <T = Info>(path: string): Promise<T> => {
    const response = await fetch(`${probe.endpoint}${path}`, { signal: requests.signal });
    if (!response.ok) throw new Error(`probe ${path} failed: ${await response.text()}`);
    return (await response.json()) as T;
  };
  /** The largest database file under the node's root: the cell's chunk file. */
  const fileBytes = async (): Promise<number> => {
    let largest = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name === "db.sqlite") largest = Math.max(largest, (await stat(path)).size);
      }
    };
    await walk(root);
    return largest;
  };
  const until = async (done: (info: Info) => boolean, ms = 20_000): Promise<Info> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const info = await call("/info");
      if (done(info)) return info;
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${JSON.stringify(info)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  return { probe, call, fileBytes, until };
}

const BODY = 20_000;
/** The same five rows, rewritten: what a commit supersedes is what a collection frees. */
const add = (n: number) => `/add?id=${(n % 5) + 1}&n=${n}&writes=8&bytes=${BODY}`;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(!celldTestBinary())(
  "a Dolt class is compacted by its base after the commits that made it due: idle, over a clean working set, geometric, and it keeps working",
  async () => {
    const { probe, call, fileBytes, until } = await startProbe("default-small");
    // The base looks at the schedule after every eighth commit of an activation (a cell that commits per
    // event would otherwise read its log per event). Seven commits: the check has not been asked for.
    for (let n = 1; n <= 7; n++) await call(add(n));
    await settle(800);
    expect((await call("/info")).gcHead).toBeNull();

    // The eighth asks for it, and the cell is due (nine commits, the schedule is six). Uncommitted work lands
    // in the quarter second before the check runs: the check leaves the cell alone.
    await call(add(8));
    await call("/dirty");
    await settle(1500);
    const held = await call("/info");
    expect(held.commits).toBeGreaterThanOrEqual(9);
    expect(held.gcHead).toBeNull();
    expect(held.status).not.toEqual([]);
    const bloated = await fileBytes();

    // The work is committed; the sixteenth commit asks again, and the cell, clean and due, is compacted.
    await call("/commit?message=keep%20pending");
    for (let n = 9; n <= 16; n++) await call(add(n));
    const first = await until((info) => info.gcHead !== null);
    expect(first.status).toEqual([]);
    const afterFirst = await fileBytes();
    // The file shrinks: the superseded versions of the rewritten rows are gone.
    expect(afterFirst).toBeLessThan(bloated);
    // eslint-disable-next-line no-console
    console.info(
      "GC",
      JSON.stringify({
        commitsBefore: held.commits,
        bytesBefore: bloated,
        commitsAfter: first.commits,
        bytesAfter: afterFirst,
      })
    );
    // Every commit is still there; the rows and the local rows are intact.
    expect(first.commits).toBeGreaterThanOrEqual(17);
    expect(first.notes.map(([id]) => id)).toEqual([1, 2, 3, 4, 5, 9999]);
    expect(Number(first.gcCommits)).toBe(first.commits);

    // The cell still reads and writes after the collection.
    await call("/mark?note=after");
    await call(add(17));
    const working = await call("/info");
    expect(working.marks).toEqual(["after"]);
    expect(working.commits).toBe(first.commits + 1);

    // The schedule is geometric: half of the commits the cell held then (nine), not six. Seven more commits
    // since the collection are not enough; the thirty-second commit's check is.
    for (let n = 18; n <= 24; n++) await call(add(n));
    await settle(1500);
    expect((await call("/info")).gcHead).toBe(first.gcHead);
    for (let n = 25; n <= 32; n++) await call(add(n));
    const second = await until((info) => info.gcHead !== null && info.gcHead !== first.gcHead);
    expect(Number(second.gcCommits)).toBe(second.commits);

    // A restart keeps the schedule (its memory is the cell's own local state) and the history.
    await probe.kill();
    await probe.start();
    const restarted = await call("/info");
    expect(restarted.gcHead).toBe(second.gcHead);
    expect(restarted.commits).toBe(second.commits);
    await call(add(33));
    expect((await call("/info")).commits).toBe(second.commits + 1);
  },
  300_000
);

it.skipIf(!celldTestBinary())(
  "a class that returns no schedule is never compacted",
  async () => {
    const { call, fileBytes } = await startProbe("never");
    for (let n = 1; n <= 16; n++) await call(add(n));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const info = await call("/info");
    expect(info.commits).toBeGreaterThanOrEqual(16);
    expect(info.gcHead).toBeNull();
    // The same 16 turns on the cell that is never collected: what the schedule above saves.
    // eslint-disable-next-line no-console
    console.info("GC-NEVER", JSON.stringify({ commits: info.commits, bytes: await fileBytes() }));
    expect(await fileBytes()).toBeGreaterThan(0);
  },
  120_000
);

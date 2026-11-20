/**
 * `WorkspaceStateDO` on the real fork. The probe verifies Dolt's schema,
 * commit history, durable reset, and local state across a restart.
 * Skipped without a celld binary (`VIBESTUDIO_CELLD_BIN`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { doltLocalPatterns, type DoltGcState } from "../../packages/durable/src/dolt.js";
import { WORKSPACE_STATE_LOCAL_TABLES } from "../../packages/service-schemas/src/workspaceStateStorage.js";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const SOURCE = "panels/example";
const AUTHORITY = { provides: [], requests: [], serviceRequests: [] };

function probeSource(): string {
  const root = process.cwd();
  return `
    import { WorkspaceStateDO as RealState } from ${JSON.stringify(`${root}/packages/builtin/src/workspace-state/WorkspaceStateDO.ts`)};
    const json = (value) => new Response(JSON.stringify(value ?? null), { headers: { 'content-type': 'application/json' } });
    async function call(self, request) {
      const { method, args } = await request.json();
      const result = await self[method](...(args ?? []));
      return json({ result: result ?? null });
    }
    export class WorkspaceStateDO extends RealState {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== '/probe') return super.fetch(request);
        await this.initializeSchema();
        const body = await request.clone().json();
        if (body.method === '__info') {
          const dolt = this.ctx.storage.dolt;
          const rows = (sql) => this.sql.exec(sql).toArray();
          return json({
            branch: dolt.branch.current(),
            compaction: this.doltGcState(),
            alarmWorker: this.getStateValue('alarm-active-worker') ?? null,
            log: dolt.log({ limit: 500 }).map((commit) => ({ message: commit.message, date: commit.date, hash: commit.hash })),
            status: dolt.status(),
            tables: rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
            contextEdges: rows("SELECT * FROM context_edges ORDER BY context_id, owner_context_id, kind"),
          });
        }
        if (body.method === '__dolt') {
          const path = body.args[0].split('.');
          const target = path.slice(0, -1).reduce((value, key) => value[key], this.ctx.storage.dolt);
          return json({ result: target[path[path.length - 1]](...body.args[1]) ?? null });
        }
        try { return await call(this, request); }
        catch (error) { return new Response(String(error && error.message || error), { status: 500 }); }
      }
    }
    export default {
      fetch(request, env) {
        const url = new URL(request.url);
        const [, name] = url.pathname.split('/');
        const stub = env.STATE.get(env.STATE.idFromName(name));
        return stub.fetch(new Request(new URL('/probe', url), { method: 'POST', body: request.body, headers: request.headers }));
      }
    };
  `;
}

async function bundleProbe(): Promise<string> {
  const result = await build({
    stdin: {
      contents: probeSource(),
      resolveDir: process.cwd(),
      sourcefile: "workspace-state-probe.ts",
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
  if (!text) throw new Error("Missing workspace-state probe bundle");
  return text;
}

async function startWorkspaceProbe() {
  const root = await mkdtemp(join(homedir(), ".workspace-state-probe-"));
  const probe = await startCelldProbe({
    root,
    bundle: await bundleProbe(),
    classes: [],
    doltClasses: ["WorkspaceStateDO"],
    bindings: [{ name: "STATE", class_name: "WorkspaceStateDO" }],
    celld: {
      durable_objects: {
        WorkspaceStateDO: { doltLocal: doltLocalPatterns([...WORKSPACE_STATE_LOCAL_TABLES]) },
      },
    },
    vars: { WORKER_CLASS_NAME: "WorkspaceStateDO" },
  });
  const requests = new AbortController();
  let cleaning: Promise<void> | undefined;
  onTestFinished(
    () =>
      (cleaning ??= (async () => {
        requests.abort(new Error("workspace state probe retired"));
        await probe.kill();
        await rm(root, { recursive: true, force: true });
      })())
  );
  await probe.start();
  const rpc = async <T = unknown>(
    name: string,
    method: string,
    ...args: unknown[]
  ): Promise<T> => {
    const response = await fetch(`${probe.endpoint}/${name}/x`, {
      method: "POST",
      body: JSON.stringify({ method, args }),
      headers: { "content-type": "application/json" },
      signal: requests.signal,
    });
    if (!response.ok) throw new Error(`${method} failed: ${await response.text()}`);
    const body = (await response.json()) as { result?: T } & T;
    return ("result" in body ? body.result : body) as T;
  };
  const state = (name: string) => ({
    call: <T = unknown>(method: string, ...args: unknown[]) =>
      rpc<T>(name, method, ...args),
    info: () =>
      rpc<{
        branch: string;
        compaction: DoltGcState;
        alarmWorker: string | null;
        log: Array<{ message: string; date: string; hash: string }>;
        status: Array<{ table: string; status: string }>;
        tables: string[];
        contextEdges: unknown[];
      }>(name, "__info"),
    dolt: <T = unknown>(method: string, ...args: unknown[]) =>
      rpc<T>(name, "__dolt", method, args),
  });
  return { probe, state };
}

const panel = (key: string) => ({
  nativeOwner: null,
  durableWorkQueues: [],
  kind: "panel" as const,
  source: { repoPath: SOURCE, effectiveVersion: "v1" },
  contextId: "ctx-1",
  key,
  activeBuildKey: "b".repeat(64),
  activeExecutionDigest: "a".repeat(64),
  activeAuthority: AUTHORITY,
});
const entry = (entity: { key: string; id: string }) => ({
  entryKey: entity.key,
  entityId: entity.id,
  source: SOURCE,
  contextId: "ctx-1",
});

type Entity = { id: string; key: string };

/** A workspace with history, built through the class on the real engine. */
it.skipIf(!celldTestBinary())(
  "the Dolt workspace store installs, commits each mutation once, undoes a close by a durable reset, and keeps local state across a kill",
  async () => {
    const { probe, state } = await startWorkspaceProbe();
    const workspace = state("ws-1");

    // The schema (partial indexes, foreign keys, CHECK) installs on the real engine as a commit.
    const installed = await workspace.info();
    expect(installed.branch).toBe("main");
    expect(installed.log.map((commit) => commit.message)).toContain("schema: WorkspaceStateDO v1");
    expect(installed.tables).toEqual(
      expect.arrayContaining(["entities", "slots", "slot_history", "do_alarms", "state"])
    );
    expect(installed.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);

    // One commit per mutation, none for an idempotent retry (dolt_status inside the transaction).
    const root = await workspace.call<Entity>("entityActivate", panel("root-entry"));
    const afterActivate = (await workspace.info()).log.length;
    await workspace.call("entityActivate", panel("root-entry"));
    expect((await workspace.info()).log.length).toBe(afterActivate);
    await workspace.call("slotCreate", {
      slotId: "root",
      parentSlotId: null,
      initialEntry: entry(root),
    });
    await workspace.call("slotCreate", {
      slotId: "root",
      parentSlotId: null,
      initialEntry: entry(root),
    });
    const afterCreate = await workspace.info();
    expect(afterCreate.log.length).toBe(afterActivate + 1);
    expect(afterCreate.log[0]?.message).toBe("create slot root");
    expect(afterCreate.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);
    const beforeClose = afterCreate.log[0]!.hash;

    // Close: one commit; the closed-panel list reads rows; the working set is clean.
    await workspace.call("slotClose", "root");
    await workspace.call("slotClose", "root");
    const closed = await workspace.info();
    expect(closed.log.length).toBe(afterCreate.log.length + 1);
    expect(closed.log[0]?.message).toBe("close panel root (1 slots)");
    // The reverse patch of the close commit touches the slot rows only: it is exactly what reopens it.
    const reverse = await workspace.dolt<{
      patch: Array<{ table: string; statement: string }>;
    }>("diff", { from: closed.log[0]!.hash, to: beforeClose });
    expect(reverse.patch.map((entry) => entry.table)).toEqual(["slots"]);
    expect(reverse.patch[0]!.statement).toMatch(/closed_at/u);

    // Operational state that must outlive the undo.
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    await workspace.call("entityActivate", {
      nativeOwner: null,
      durableWorkQueues: [],
      kind: "do",
      source: { repoPath: SOURCE, effectiveVersion: "v1" },
      contextId: "ctx-1",
      className: key.className,
      key: key.objectKey,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: AUTHORITY,
    });
    await workspace.call("alarmAdoptWorker", "driver-1");
    await workspace.call("alarmSet", { ...key, wakeAt: 4_102_444_800_000 });
    await workspace.call("lifecycleLeaseUpsert", { ...key, detail: { turnId: "t" } });
    const revision = (
      await workspace.call<{ revision: number }>("panelTreeRootGroups", { limit: 5 })
    ).revision;

    // The undo of the close is a hard reset, and it survives a kill.
    await workspace.dolt("reset", { hard: true, to: beforeClose });
    expect(
      (await workspace.call<{ closed_at: number | null }>("slotGet", "root")).closed_at
    ).toBeNull();
    await probe.kill();
    await probe.start();
    expect(
      (await workspace.call<{ closed_at: number | null }>("slotGet", "root")).closed_at
    ).toBeNull();
    // Local tables were neither rewound nor lost; the revision did not go backwards.
    expect(await workspace.call("alarmNextWakeAt", 0)).toBe(4_102_444_800_000);
    expect(await workspace.call<unknown[]>("lifecycleListLeases")).toHaveLength(1);
    expect(
      (await workspace.call<{ revision: number }>("panelTreeRootGroups", { limit: 5 })).revision
    ).toBeGreaterThanOrEqual(revision);

    // Reopen as a commit of its own, after a close, on the restarted node.
    await workspace.call("slotClose", "root");
    await workspace.call("slotCloseCleanupAck", ["root"]);
    const plan = await workspace.call<{
      closedAt: number;
      slots: Array<{ entry: { entry_key: string } }>;
    }>("slotReopenPlan", "root");
    for (const { entry: history } of plan.slots) {
      await workspace.call("entityActivate", panel(history.entry_key));
    }
    await workspace.call("slotReopen", { slotId: "root", closedAt: plan.closedAt });
    const reopened = await workspace.info();
    expect(reopened.log[0]?.message).toBe("reopen panel root (1 slots)");
    expect(reopened.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);
  },
  240_000
);

it.skipIf(!celldTestBinary())(
  "the product workspace store compacts on the inherited default schedule and keeps history and local state across a crash",
  async () => {
    const { probe, state } = await startWorkspaceProbe();
    const workspace = state("ws-default-gc");
    const initial = await workspace.info();
    const edge = (n: number) => ({
      contextId: `gc-child-${n}`,
      ownerContextId: "gc-owner",
      kind: "lineage",
    });
    for (let n = 1; n <= 48; n++) await workspace.call("contextEdgeUpsert", edge(n));
    const young = await workspace.info();
    expect(young.log).toHaveLength(initial.log.length + 48);
    expect(young.compaction.lastCollectedHead).toBeNull();
    await workspace.call("alarmAdoptWorker", "gc-probe-driver");
    for (let n = 49; n <= 65; n++) await workspace.call("contextEdgeUpsert", edge(n));

    // Observe the scheduled production check; do not lower the threshold or call gc from the test.
    await expect
      .poll(async () => (await workspace.info()).compaction?.lastCollectedHead ?? null, {
        timeout: 20_000,
        interval: 200,
      })
      .not.toBeNull();
    const collected = await workspace.info();
    expect(collected.log).toHaveLength(initial.log.length + 65);
    expect(collected.compaction.head).toBe(collected.log[0]?.hash);
    expect(collected.log.map((commit) => commit.hash)).toContain(
      collected.compaction.lastCollectedHead
    );
    expect(Number(collected.compaction.observedCommitsAtLastCollection)).toBeGreaterThanOrEqual(64);
    expect(Number(collected.compaction.observedCommitsAtLastCollection)).toBeLessThanOrEqual(
      collected.log.length
    );
    expect(collected.contextEdges).toHaveLength(65);
    expect(collected.alarmWorker).toBe("gc-probe-driver");
    expect(collected.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);

    await probe.kill();
    await probe.start();
    const restored = await workspace.info();
    expect(restored.log).toEqual(collected.log);
    expect(restored.contextEdges).toEqual(collected.contextEdges);
    expect(restored.compaction.lastCollectedHead).toBe(collected.compaction.lastCollectedHead);
    expect(restored.compaction.observedCommitsAtLastCollection).toBe(
      collected.compaction.observedCommitsAtLastCollection
    );
    expect(restored.alarmWorker).toBe(collected.alarmWorker);
    await workspace.call("contextEdgeUpsert", edge(66));
    const continued = await workspace.info();
    expect(continued.log).toHaveLength(initial.log.length + 66);
    expect(continued.contextEdges).toHaveLength(66);
    expect(continued.compaction.lastCollectedHead).toBe(restored.compaction.lastCollectedHead);
  },
  120_000
);

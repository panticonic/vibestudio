// Owner-side client of the ownership library.
//
// An owner is any process that spawns detached groups or needs scratch space.
// `Ownership.open` starts that owner's reaper (reaper.mjs), which holds the
// lease and retires everything the owner registered, whether the owner
// releases normally or dies. Plain `.mjs` so scripts without a TypeScript
// loader can use it.
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  captureOwnedProcessIdentity,
  captureProcessStart,
  signalOwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";
import {
  ledgerDirOf,
  readLedger,
  retireLedger,
  scratchDirOf,
  validateLedgerId,
} from "./ownershipLedger.mjs";
import { LEASE_FD_ENV } from "./ownershipLease.mjs";

export {
  awaitReady,
  awaitRetirement,
  readLedger,
  summarizeLedger,
  sweep,
} from "./ownershipLedger.mjs";
export { watchLease } from "./ownershipLease.mjs";

/**
 * The reaper beside this module. Resolved when a reaper is started, not at
 * import: a bundle may be loaded where `import.meta.url` is unusable, and then
 * only an explicit `reaperPath` can work.
 */
function defaultReaperPath() {
  try {
    return fileURLToPath(new URL("./reaper.mjs", import.meta.url));
  } catch (cause) {
    throw ownershipError(
      "Cannot locate reaper.mjs beside the ownership module; pass Ownership.open({ reaperPath })",
      { cause }
    );
  }
}

/**
 * How the reaper process is started from ANY host runtime.
 *
 * The reaper is plain Node JS run by the owner's own executable. In Electron
 * (main process, utility process) that executable is the Electron binary, which
 * only behaves as Node when ELECTRON_RUN_AS_NODE=1. The flag is set on the
 * reaper's environment alone: workloads are spawned by `Ownership.spawn` from
 * the owner's environment and never see it.
 *
 * The rest of the environment is passed through except what would change how a
 * "plain JS, no loader" reaper starts: NODE_OPTIONS (an owner launched with
 * `--import tsx` must not make every reaper load tsx) and the owner's own
 * lease descriptor (it names a descriptor of the owner, not of the reaper).
 * Pure: exported so the Electron case is testable without Electron.
 */
export function buildReaperSpawn({
  reaperPath,
  config,
  execPath = process.execPath,
  versions = process.versions,
  platform = process.platform,
  env = process.env,
}) {
  const reaperEnv = { ...env };
  delete reaperEnv.NODE_OPTIONS;
  delete reaperEnv.ELECTRON_RUN_AS_NODE;
  delete reaperEnv[LEASE_FD_ENV];
  if (versions.electron) reaperEnv.ELECTRON_RUN_AS_NODE = "1";
  return {
    command: execPath,
    args: [reaperPath, JSON.stringify(config)],
    options: {
      env: reaperEnv,
      // Its own process group: outside every workload it retires.
      detached: platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  };
}

/**
 * The promise `spawn`/`spawnDetached`/`adopt` return as `registered`. A
 * registration failure is reported once: to whoever observed this promise
 * (awaited it, or called `join()`/`retire()`, which do), otherwise by the
 * owner's `release()`. Observation is a `then` call, which `await`, `catch`
 * and `finally` all make.
 */
class Registration extends Promise {
  static get [Symbol.species]() {
    return Promise;
  }
  observed = false;
  then(onFulfilled, onRejected) {
    this.observed = true;
    return super.then(onFulfilled, onRejected);
  }
}

function ownershipError(message, props = {}) {
  return Object.assign(new Error(message), { code: "EOWNERSHIP", ...props });
}
const flatten = (error) => (error instanceof AggregateError ? error.errors : [error]);
function aggregate(errors, message) {
  return Object.assign(new AggregateError(errors, message), { code: "EOWNERSHIP" });
}
function revive(failure) {
  return Object.assign(new Error(failure.message), {
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.stack ? { stack: failure.stack } : {}),
  });
}

export class OwnershipClaimedError extends Error {
  code = "ECLAIMED";
  constructor(holder) {
    super(`Ownership id ${holder.id} is held by a live owner`);
    this.holder = holder;
  }
}

export class OwnedScope {
  #work = new Set();
  #failures = [];
  #cleanups = [];
  #closing = null;

  track(work) {
    const tracked = Promise.resolve(work);
    const entry = tracked.then(
      () => undefined,
      (error) => {
        this.#failures.push(error);
      }
    );
    this.#work.add(entry);
    void entry.then(() => this.#work.delete(entry));
    return tracked;
  }

  defer(cleanup) {
    this.#cleanups.push(cleanup);
  }

  close() {
    this.#closing ??= (async () => {
      while (this.#cleanups.length) {
        const cleanup = this.#cleanups.pop();
        try {
          await cleanup();
        } catch (error) {
          this.#failures.push(error);
        }
      }
      // Work tracked while draining is joined too.
      while (this.#work.size) await Promise.all([...this.#work]);
      if (this.#failures.length) {
        throw aggregate(this.#failures.flatMap(flatten), "Owned work did not settle cleanly");
      }
    })();
    return this.#closing;
  }
}

export class Ownership {
  #child;
  #owner;
  #exited;
  #token;
  #nextRid = 1;
  #pending = new Map();
  #groups = new Map();
  #children = [];
  #leases = [];
  #abort = new AbortController();
  #lost = null;
  #released = false;
  #releasing = null;

  /** @private use `Ownership.open` */
  constructor(options, id, child, exited, token) {
    this.id = id;
    this.profileDir = options.profileDir;
    this.ledgerDir = ledgerDirOf(options.profileDir);
    this.lifetime = options.lifetime;
    this.scope = new OwnedScope();
    this.signal = this.#abort.signal;
    this.#child = child;
    this.#exited = exited;
    this.#token = token;
    /** This claim's ledger token: pass it to `awaitRetirement(..., { token })`. */
    this.token = token;
  }

  static async open(options) {
    if (!path.isAbsolute(options.profileDir)) {
      throw ownershipError("Ownership requires an absolute profile directory");
    }
    if (options.lifetime !== "leased" && options.lifetime !== "until-stop") {
      throw ownershipError("Ownership requires a lifetime of 'leased' or 'until-stop'");
    }
    const id = validateLedgerId(
      options.id ?? `own-${process.pid}-${randomBytes(4).toString("hex")}`
    );
    fs.mkdirSync(scratchDirOf(options.profileDir), { recursive: true, mode: 0o700 });
    const config = {
      profileDir: options.profileDir,
      id,
      lifetime: options.lifetime,
      owner: captureProcessStart(process.pid),
      meta: options.meta ?? {},
    };
    const reaperPath = options.reaperPath ?? defaultReaperPath();
    if (!fs.existsSync(reaperPath)) {
      throw ownershipError(
        `The ownership reaper is not at ${reaperPath}; it must ship as a plain file (see ownershipFiles.mjs)`
      );
    }
    const plan = buildReaperSpawn({ reaperPath, config });
    const child = spawnProcess(plan.command, plan.args, plan.options);
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    // The reaper must not outlive a failed open.
    const first = await new Promise((resolve, reject) => {
      child.once("message", (message) => resolve(message));
      exited.then(
        (status) =>
          reject(
            ownershipError(
              `Ownership reaper exited before the claim completed (code ${status.code}, signal ${status.signal})`,
              { reaperStatus: status }
            )
          ),
        reject
      );
    });
    if (first?.t === "claim-failed") {
      await exited;
      throw new OwnershipClaimedError(first.holder);
    }
    if (first?.t !== "claimed") {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
      throw ownershipError(
        `Ownership reaper could not claim ${id}: ${first?.failure?.message ?? "unexpected reply"}`
      );
    }
    const ownership = new Ownership(options, id, child, exited, first.token);
    ownership.#attach();
    return ownership;
  }

  #attach() {
    this.#child.on("message", (message) => {
      if (!message || typeof message.rid !== "number") return;
      const pending = this.#pending.get(message.rid);
      if (!pending) return;
      this.#pending.delete(message.rid);
      if (message.t === "released") pending.resolve(message);
      else if (message.ok) pending.resolve(message.value);
      else pending.reject(revive(message.failure));
    });
    // `disconnect` follows every message the reaper sent, so a reply to a
    // release is never mistaken for a death.
    this.#child.once("disconnect", () => {
      void this.#exited.then(
        (status) => this.#reaperGone(status),
        (error) => this.#reaperGone({ code: null, signal: null }, error)
      );
    });
  }

  async #reaperGone(status, spawnError) {
    if (this.#released) return;
    // The lease is gone with its holder. Retire in-process from the ledger the
    // dead reaper left, plus any group it never acknowledged.
    const failures = [];
    try {
      const ledger = readLedger(this.ledgerDir, this.id);
      const known = new Map((ledger?.groups ?? []).map((group) => [group.key, group]));
      for (const [key, group] of this.#groups) if (!known.has(key)) known.set(key, group);
      if (ledger && ledger.token === this.#token) {
        await retireLedger({ ...ledger, groups: [...known.values()] }, { dir: this.ledgerDir });
      } else {
        for (const group of known.values()) {
          if (group.identity && !group.outlives) {
            signalOwnedProcessIdentity(group.identity, "SIGKILL");
          }
        }
      }
    } catch (error) {
      failures.push(...flatten(error));
    }
    const lost = ownershipError(
      `Ownership reaper for ${this.id} exited before release (code ${status.code}, signal ${status.signal})`,
      {
        reaperStatus: status,
        ...(failures.length
          ? { cause: aggregate(failures, "In-process retirement after reaper loss failed") }
          : spawnError
            ? { cause: spawnError }
            : {}),
      }
    );
    this.#lost = lost;
    this.#abort.abort(lost);
    for (const pending of this.#pending.values()) pending.reject(lost);
    this.#pending.clear();
  }

  #assertUsable() {
    if (this.#lost) throw this.#lost;
    if (this.#releasing) throw ownershipError(`Ownership ${this.id} is released`);
  }

  #request(message) {
    if (this.#lost) return Promise.reject(this.#lost);
    return new Promise((resolve, reject) => {
      const rid = this.#nextRid++;
      this.#pending.set(rid, { resolve, reject });
      try {
        this.#child.send({ ...message, rid }, (error) => {
          if (error && this.#pending.delete(rid)) {
            reject(
              this.#lost ?? ownershipError(`Ownership reaper channel failed: ${error.message}`)
            );
          }
        });
      } catch (error) {
        this.#pending.delete(rid);
        reject(this.#lost ?? error);
      }
    });
  }

  /**
   * Spawn a workload in its own process group and register the group with the
   * reaper in the same synchronous turn. The reaper retires it (per `kill`) at
   * `release()`, or when this owner dies. The group's env never carries the
   * owner's lease descriptor unless `lease: true`.
   */
  spawn(command, args, options) {
    this.#assertUsable();
    const { kill, label, lease, ...spawnOptions } = options ?? {};
    if (kill !== "graceful" && kill !== "immediate") {
      throw new TypeError("Ownership.spawn requires kill: 'graceful' | 'immediate'");
    }
    let stdio = spawnOptions.stdio ?? "pipe";
    let leaseIndex = -1;
    const env = { ...(spawnOptions.env ?? process.env) };
    delete env[LEASE_FD_ENV];
    if (lease) {
      stdio = typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio];
      while (stdio.length < 3) stdio.push("pipe");
      leaseIndex = stdio.length;
      stdio.push("pipe");
      env[LEASE_FD_ENV] = String(leaseIndex);
    }
    const child = spawnProcess(command, [...args], {
      ...spawnOptions,
      stdio,
      env,
      detached: process.platform !== "win32",
    });
    const closed = new Promise((resolve) => child.once("close", () => resolve()));
    this.#children.push(closed);
    if (leaseIndex >= 0) {
      const socket = child.stdio[leaseIndex];
      if (socket) {
        // Our end must stay open for the owner's whole life and must be read,
        // or the child's `close` would never see the stream end.
        socket.on("error", () => undefined);
        socket.resume();
        socket.unref?.();
        this.#leases.push(socket);
      }
    }
    return this.#register(child, { kill, label, closed, spawnTime: true });
  }

  /**
   * Spawn a child that DELIBERATELY outlives this owner: the `until-stop`
   * instance supervisor, which is owned from then on by its own `Ownership`.
   * This is the only sanctioned way to start a detached process that is not
   * retired by this owner (callers never write `detached: true` themselves).
   *
   * What it registers: the child's process-group identity, in this owner's
   * ledger, marked `outlives`. The record exists so that the group is visible
   * (`readLedger`, diagnostics) and so the handover is explicit; it is NOT
   * retired by `release()`, by this owner's death, or by any sweep: retirement
   * forgets it without signalling. Who retires it: the successor, through the
   * ledger it opens itself (its reaper kills the group's descendants if the
   * successor dies; `stop` retires it via `awaitRetirement`). Until the
   * successor has claimed its own ledger nothing but the successor itself is
   * running, so there is nothing for this owner to leave behind.
   *
   * Differences from `spawn`: `kill` defaults to "graceful" and applies only to
   * an explicit `retire()`; no lease is possible (a lease ends with its owner);
   * `stdio` defaults to "ignore" and the child is `unref`'d, and `release()`
   * does not wait for it or its stdio. A caller that asks for stdio pipes owns
   * closing them.
   */
  spawnDetached(command, args, options) {
    this.#assertUsable();
    const { kill = "graceful", label, lease, ...spawnOptions } = options ?? {};
    if (lease) throw new TypeError("Ownership.spawnDetached cannot carry a lease");
    if (kill !== "graceful" && kill !== "immediate") {
      throw new TypeError("Ownership.spawnDetached kill must be 'graceful' | 'immediate'");
    }
    const env = { ...(spawnOptions.env ?? process.env) };
    delete env[LEASE_FD_ENV];
    const child = spawnProcess(command, [...args], {
      ...spawnOptions,
      stdio: spawnOptions.stdio ?? "ignore",
      env,
      detached: process.platform !== "win32",
    });
    child.unref();
    const closed = new Promise((resolve) => child.once("close", () => resolve()));
    return this.#register(child, { kill, label, closed, spawnTime: true, outlives: true });
  }

  /**
   * Register a child that is ALREADY RUNNING and that this owner did not spawn
   * through the library (for example Playwright's `electron.launch`), so its
   * group is retired by the reaper like a `spawn`ed one. Identity is captured
   * by the same path as `spawn`.
   *
   * Limits: the child must be the leader of its own process group (it was
   * started detached; otherwise this throws and nothing is registered or
   * killed: retiring a group means signalling the whole group). It cannot be
   * given a lease or a stdio layout, and its stdio is the adopter's concern, so
   * `join()`/`retire()` wait for the process group to be gone, not for stdio to
   * close, and `release()` does not wait for the adoptee's stdio. A child that
   * has already exited cannot be adopted (the call throws).
   */
  adopt(child, options) {
    this.#assertUsable();
    const { kill, label } = options ?? {};
    if (kill !== "graceful" && kill !== "immediate") {
      throw new TypeError("Ownership.adopt requires kill: 'graceful' | 'immediate'");
    }
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw ownershipError("Ownership.adopt requires a running child process");
    }
    const identity = process.platform === "win32" ? null : captureOwnedProcessIdentity(child.pid);
    // Not tracked in #children: waiting for the adoptee's stdio to close would
    // wait on a stream this owner does not control.
    const closed = new Promise((resolve) => child.once("exit", () => resolve()));
    return this.#register(child, { kill, label, closed, identity });
  }

  /**
   * Shared by spawn/spawnDetached/adopt: capture the identity (unless given),
   * record the group with the reaper in the same synchronous turn, and build
   * the `OwnedProcess`.
   */
  #register(child, { kill, label, closed, outlives = false, identity: given, spawnTime = false }) {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    let identity = given ?? null;
    let key = null;
    let base;
    if (child.pid === undefined) {
      base = new Promise((_, reject) => {
        child.once("error", (error) => reject(error));
      });
    } else {
      try {
        // Same synchronous turn as the spawn: the message is in the kernel's
        // socket buffer before this function returns, so even an owner killed
        // now has its group retired by the reaper.
        if (spawnTime) {
          identity = process.platform === "win32" ? null : captureOwnedProcessIdentity(child.pid);
        }
        key = identity ? `${identity.pid}:${identity.startCoordinate}` : String(child.pid);
        this.#groups.set(key, { key, pid: child.pid, identity, kill, outlives });
        base = this.#request({
          t: "register",
          group: {
            pid: child.pid,
            identity,
            kill,
            ...(label === undefined ? {} : { label }),
            ...(outlives ? { outlives: true } : {}),
          },
        }).then(() => undefined);
      } catch (error) {
        base = Promise.reject(error);
      }
      base = base.catch((error) => {
        // An unrecorded group is an unowned one.
        try {
          if (identity) signalOwnedProcessIdentity(identity, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The original registration failure is what the caller must see.
        }
        throw error;
      });
    }
    const registered = new Registration((resolve, reject) => base.then(resolve, reject));
    // The returned promise reports to its observers; this keeps an unobserved
    // rejection from also being an unhandled one (release reports it instead).
    Promise.prototype.then.call(registered, undefined, () => undefined);
    this.scope.defer(async () => {
      try {
        await base;
      } catch (error) {
        if (!registered.observed) throw error;
      }
    });

    const retireVia = async (mode) => {
      await registered;
      // Once release has begun the reaper retires every group itself.
      if (key !== null && !this.#releasing) {
        await this.#request({ t: "retire", key, ...(mode ? { mode } : {}) });
        this.#groups.delete(key);
      }
      await closed;
    };
    return {
      child,
      identity,
      registered,
      retire: (mode) => retireVia(mode),
      join: async () => {
        if (child.pid !== undefined) await exited;
        await retireVia(undefined);
      },
    };
  }

  async scratch(prefix) {
    this.#assertUsable();
    return (await this.#request({ t: "scratch", prefix })).path;
  }

  async own(target, label) {
    this.#assertUsable();
    await this.#request({ t: "own", path: target, ...(label === undefined ? {} : { label }) });
  }

  async annotate(patch) {
    this.#assertUsable();
    await this.#request({ t: "meta", patch });
  }

  async markReady() {
    this.#assertUsable();
    await this.#request({ t: "ready" });
  }

  async escalate() {
    this.#assertUsable();
    await this.#request({ t: "escalate" });
  }

  release() {
    this.#releasing ??= (async () => {
      const failures = [];
      try {
        await this.scope.close();
      } catch (error) {
        failures.push(...flatten(error));
      }
      try {
        const reply = await this.#request({ t: "release" });
        this.#released = true;
        failures.push(...reply.failures.map(revive));
      } catch (error) {
        failures.push(error);
      }
      await this.#exited.catch(() => undefined);
      await Promise.all(this.#children);
      if (failures.length)
        throw aggregate(failures, `Ownership ${this.id} did not release cleanly`);
    })();
    return this.#releasing;
  }

  close() {
    return this.release();
  }
}

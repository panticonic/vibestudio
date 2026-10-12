import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { prepareWorkspaceRelease } from "./prepare-workspace-release.mjs";

async function withProducer(
  code,
  check,
  configureAppRoot = async (root) => root,
  configureEnv = async () => {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-release-lifecycle-"));
  let owner;
  try {
    const appRoot = await configureAppRoot(root);
    const entry = path.join(root, "producer.cjs");
    await fs.writeFile(entry, code);
    const env = { ...process.env };
    delete env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT;
    await configureEnv(env, root);
    owner = prepareWorkspaceRelease({
      appRoot,
      output: root,
      scratch: path.join(root, "scratch"),
      env,
      executable: process.execPath,
      entry,
    });
    await check(owner, root, env);
  } finally {
    await owner?.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

void test("validates a declared release through the producer and preserves borrowed output", async () => {
  await withProducer(
    `const fs=require("fs"); const output=process.argv[process.argv.indexOf("--output")+1]; fs.writeFileSync("selected-output",output); process.send({kind:"completed"},()=>process.disconnect());`,
    async (owner, root, env) => {
      await owner.completed;
      const output = path.join(root, "borrowed");
      assert.equal(await fs.readFile(path.join(root, "selected-output"), "utf8"), output);
      await owner.stop();
      assert.equal(env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT, output);
      assert.equal(
        await fs.readFile(path.join(output, "userland-builds", "release.json"), "utf8"),
        "{}"
      );
    },
    undefined,
    async (env, root) => {
      env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT = path.join(root, "borrowed");
      await fs.mkdir(path.join(env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT, "userland-builds"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT, "userland-builds", "release.json"),
        "{}"
      );
    }
  );
});

void test("rejects missing declared releases before starting a producer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-release-missing-"));
  try {
    assert.throws(
      () =>
        prepareWorkspaceRelease({
          appRoot: root,
          output: path.join(root, "new"),
          scratch: path.join(root, "scratch"),
          env: { ...process.env, VIBESTUDIO_WORKSPACE_RELEASE_ROOT: path.join(root, "missing") },
          executable: process.execPath,
          entry: path.join(root, "must-not-start.cjs"),
        }),
      { code: "ENOENT" }
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = path.dirname(file);
  const name = path.basename(file);
  await new Promise((resolve, reject) => {
    const watcher = fsSync.watch(directory, (_event, changed) => {
      if (changed?.toString() !== name) return;
      watcher.close();
      resolve();
    });
    watcher.once("error", reject);
    void fs.readFile(file, "utf8").then(
      () => {
        watcher.close();
        resolve();
      },
      (error) => {
        if (error.code === "ENOENT") return;
        watcher.close();
        reject(error);
      }
    );
  });
  return await fs.readFile(file, "utf8");
}

void test("launches the producer from its entry directory and joins completion", async () => {
  await withProducer(
    `process.send({kind:"completed"},()=>process.disconnect());`,
    async (owner, root, env) => {
      await owner.completed;
      assert.equal(env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"], root);
    },
    async (root) => {
      const appRoot = path.join(root, "app.asar");
      await fs.writeFile(appRoot, "packed application archive");
      return appRoot;
    }
  );
});

void test("keeps the producer owned until completion and joins explicit cancellation", async () => {
  await withProducer(
    `process.on("message", () => {}); process.on("SIGTERM", () => { require("fs").writeFileSync("joined", "retired"); process.disconnect(); }); require("fs").writeFileSync("started", "running");`,
    async (owner, root, env) => {
      let completed = false;
      void owner.completed.finally(() => (completed = true)).catch(() => {});
      await waitForFile(path.join(root, "started"));
      assert.equal(completed, false);
      await owner.stop();
      assert.equal(await fs.readFile(path.join(root, "joined"), "utf8"), "retired");
      assert.equal(completed, true);
      assert.equal(env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"], undefined);
    }
  );
});

void test("propagates the original producer failure through completion", async () => {
  const sourceFailure = Object.assign(new Error("source build broke"), { code: "ECOMPILER" });
  const failure = JSON.stringify(serializeRpcFailure(sourceFailure));
  await withProducer(
    `process.send({kind:"failed",failure:${failure}},()=>{process.exitCode=1;process.disconnect();});`,
    async (owner) => {
      await assert.rejects(owner.completed, { message: "source build broke", code: "ECOMPILER" });
    }
  );
});

void test("preserves failures when a later completion receipt violates the protocol", async () => {
  const sourceFailure = Object.assign(new Error("source build broke"), { code: "ECOMPILER" });
  const failure = JSON.stringify(serializeRpcFailure(sourceFailure));
  await withProducer(
    `process.send({kind:"failed",failure:${failure}},()=>process.send({kind:"completed"},()=>{process.exitCode=1;process.disconnect();}));`,
    async (owner) => {
      await assert.rejects(owner.completed, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, "source build broke");
        assert.equal(error.errors[0].code, "ECOMPILER");
        assert.equal(error.cause, error.errors[0]);
        assert.match(error.errors[1].message, /invalid completion receipt/);
        return true;
      });
    }
  );
});

void test("preserves an earlier failure when a completion receipt is duplicated", async () => {
  const sourceFailure = Object.assign(new Error("source build broke"), { code: "ECOMPILER" });
  const failure = JSON.stringify(serializeRpcFailure(sourceFailure));
  await withProducer(
    `process.send({kind:"completed"},()=>process.send({kind:"failed",failure:${failure}},()=>process.send({kind:"completed"},()=>{process.exitCode=1;process.disconnect();})));`,
    async (owner) => {
      await assert.rejects(owner.completed, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, "source build broke");
        assert.equal(error.errors[0].code, "ECOMPILER");
        assert.match(error.errors[1].message, /invalid completion receipt/);
        return true;
      });
    }
  );
});

void test("round-trips aggregate causes and shared error identity through producer IPC", async () => {
  const cause = Object.assign(new Error("underlying compiler failure"), { code: "EIO" });
  const aggregate = new AggregateError([cause], "compiler and setup failed", { cause });
  const failure = JSON.stringify(serializeRpcFailure(aggregate));
  await withProducer(
    `process.send({kind:"failed",failure:${failure}},()=>{process.exitCode=1;process.disconnect();});`,
    async (owner) => {
      await assert.rejects(owner.completed, (caught) => {
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, "compiler and setup failed");
        assert.equal(caught.errors[0].message, "underlying compiler failure");
        assert.equal(caught.errors[0], caught.cause);
        return true;
      });
    }
  );
});

void test("turns a malformed terminal failure receipt into the joined completion error", async () => {
  await withProducer(
    `process.send({kind:"failed",failure:{version:1,nodes:[],root:{ref:0}}},()=>process.disconnect());`,
    async (owner) => {
      await assert.rejects(owner.completed, /RPC failure|failure graph|invalid/i);
    }
  );
});

void test("stop reports an operation failure joined with its cancellation", async () => {
  const sourceFailure = Object.assign(new Error("staged adapter failed"), { code: "EIO" });
  const childFailure = JSON.stringify(
    serializeRpcFailure(
      new AggregateError(
        [
          sourceFailure,
          Object.assign(new Error("Workspace release preparation cancelled"), {
            code: "ECANCELLED",
          }),
        ],
        "operation and cancellation both failed",
        { cause: sourceFailure }
      )
    )
  );
  await withProducer(
    `process.on("message",()=>{}); process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${childFailure}},()=>{process.exitCode=1;process.disconnect();});}); require("fs").writeFileSync("started", "running");`,
    async (owner, root) => {
      await waitForFile(path.join(root, "started"));
      await assert.rejects(owner.stop(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /operation and cancellation/);
        assert.equal(error.errors[0].message, "staged adapter failed");
        return true;
      });
    }
  );
});

void test("an ECANCELLED aggregate does not hide an independent cleanup failure", async () => {
  const cause = Object.assign(new Error("cleanup failed"), { code: "EIO" });
  const cancellationGraph = JSON.stringify(
    serializeRpcFailure(
      Object.assign(new AggregateError([cause], "cancellation cleanup failed", { cause }), {
        code: "ECANCELLED",
      })
    )
  );
  await withProducer(
    `process.on("message",()=>{}); process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${cancellationGraph}},()=>{process.exitCode=1;process.disconnect();});}); require("fs").writeFileSync("started", "running");`,
    async (owner, root) => {
      await waitForFile(path.join(root, "started"));
      await assert.rejects(owner.stop(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, "cleanup failed");
        return true;
      });
    }
  );
});

void test("an ownership failure caused by cancellation is not cancellation-only", async () => {
  const cancellation = Object.assign(new Error("cancelled"), { code: "ECANCELLED" });
  const ownership = Object.assign(
    new Error("ownership retirement failed", { cause: cancellation }),
    { code: "EOWNERSHIP" }
  );
  const graph = JSON.stringify(serializeRpcFailure(ownership));
  await withProducer(
    `process.on("message",()=>{}); process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${graph}},()=>{process.exitCode=1;process.disconnect();});}); require("fs").writeFileSync("started", "running");`,
    async (owner, root) => {
      await waitForFile(path.join(root, "started"));
      await assert.rejects(owner.stop(), (error) => {
        assert.equal(error.code, "EOWNERSHIP");
        return true;
      });
    }
  );
});

void test("a cyclic application error cannot establish cancellation-only completion", async () => {
  const cyclic = new Error("application failure");
  cyclic.cause = cyclic;
  const graph = JSON.stringify(serializeRpcFailure(cyclic));
  await withProducer(
    `process.on("message",()=>{}); process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${graph}},()=>{process.exitCode=1;process.disconnect();});}); require("fs").writeFileSync("started", "running");`,
    async (owner, root) => {
      await waitForFile(path.join(root, "started"));
      await assert.rejects(owner.stop(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, "application failure");
        assert.equal(error.errors[0].cause, error.errors[0]);
        return true;
      });
    }
  );
});

void test("stop accepts the child's cancellation receipt after joining it", async () => {
  const cancellation = JSON.stringify(
    serializeRpcFailure(
      Object.assign(new Error("Workspace release preparation cancelled"), { code: "ECANCELLED" })
    )
  );
  await withProducer(
    `process.on("message",()=>{}); process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${cancellation}},()=>{process.exitCode=1;process.disconnect();});}); require("fs").writeFileSync("started", "running");`,
    async (owner, root) => {
      await waitForFile(path.join(root, "started"));
      await owner.stop();
    }
  );
});

void test("a completion receipt is not handed off until the producer exits", async () => {
  const script = `const fs=require("fs"); process.send({kind:"completed"},()=>{const finish=()=>{if(fs.existsSync("allow-exit")){watcher.close();process.disconnect();}}; const watcher=fs.watch(".",finish); finish(); fs.writeFileSync("receipt-sent","yes");});`;
  await withProducer(script, async (owner, root, env) => {
    await waitForFile(path.join(root, "receipt-sent"));
    assert.equal(env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"], undefined);
    await fs.writeFile(path.join(root, "allow-exit"), "yes");
    await owner.completed;
    assert.equal(env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"], root);
  });
});

void test("rejects a clean producer exit without a completion receipt", async () => {
  await withProducer(`process.disconnect();`, async (owner) => {
    await assert.rejects(owner.completed, /without a completed release receipt/);
  });
});

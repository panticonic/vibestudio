import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { prepareWorkspaceRelease } from "./prepare-workspace-release.mjs";

async function withProducer(code, check, configureAppRoot = async (root) => root) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-release-lifecycle-"));
  let owner;
  try {
    const appRoot = await configureAppRoot(root);
    const entry = path.join(root, "producer.cjs");
    await fs.writeFile(entry, code);
    owner = prepareWorkspaceRelease({
      appRoot,
      output: root,
      scratch: path.join(root, "scratch"),
      env: { ...process.env },
      executable: process.execPath,
      entry,
    });
    await check(owner, root);
  } finally {
    // Every failure assertion belongs to the test body; stop still joins the
    // process and streams, while its already-observed completion error is not
    // allowed to replace that assertion during fixture cleanup.
    await owner?.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

void test("launches the producer from its entry directory when the packaged app root is a file", async () => {
  await withProducer(
    `process.send({kind:"sources-ready"}, () => process.disconnect());`,
    async (owner) => {
      await owner.sourcesReady;
      await owner.completed;
    },
    async (root) => {
      const appRoot = path.join(root, "app.asar");
      await fs.writeFile(appRoot, "packed application archive");
      return appRoot;
    }
  );
});

void test("publishes source readiness while compilation remains owned, then joins explicit cancellation", async () => {
  await withProducer(
    `process.on("message", () => {}); process.on("SIGTERM", () => { require("fs").writeFileSync("joined", "retired"); process.disconnect(); }); process.send({kind:"sources-ready"});`,
    async (owner, root) => {
      let completed = false;
      void owner.completed
        .finally(() => {
          completed = true;
        })
        .catch(() => {});
      await owner.sourcesReady;
      assert.equal(completed, false);
      await owner.stop();
      assert.equal(await fs.readFile(path.join(root, "joined"), "utf8"), "retired");
      assert.equal(completed, true);
    }
  );
});

void test("completion succeeds after publication and IPC retirement", async () => {
  await withProducer(
    `process.send({kind:"sources-ready"}, () => process.disconnect());`,
    async (owner) => {
      await owner.sourcesReady;
      await owner.completed;
    }
  );
});

for (const ready of [false, true])
  void test(`propagates the original producer failure ${ready ? "after" : "before"} readiness`, async () => {
    const sourceFailure = Object.assign(new Error("source build broke"), { code: "ECOMPILER" });
    const failure = JSON.stringify(serializeRpcFailure(sourceFailure));
    await withProducer(
      `${ready ? 'process.send({kind:"sources-ready"});' : ""} process.send({kind:"failed",failure:${failure}},()=>{process.exitCode=1;process.disconnect();});`,
      async (owner) => {
        if (ready) await owner.sourcesReady;
        else
          await assert.rejects(owner.sourcesReady, {
            message: "source build broke",
            code: "ECOMPILER",
          });
        await assert.rejects(owner.completed, { message: "source build broke", code: "ECOMPILER" });
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
      let caught;
      try {
        await owner.completed;
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof AggregateError);
      assert.equal(caught.message, "compiler and setup failed");
      assert.equal(caught.errors[0].message, "underlying compiler failure");
      assert.equal(caught.errors[0], caught.cause);
    }
  );
});

void test("turns a malformed terminal failure receipt into the joined completion error", async () => {
  await withProducer(
    `process.send({kind:"failed",failure:{version:1,nodes:[],root:{ref:0}}},()=>process.disconnect());`,
    async (owner) => {
      await assert.rejects(owner.completed, /RPC failure|failure graph|invalid/i);
      await assert.rejects(owner.sourcesReady, /RPC failure|failure graph|invalid/i);
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
          Object.assign(new Error("Template preparation cancelled"), { code: "ECANCELLED" }),
        ],
        "operation and cancellation both failed",
        { cause: sourceFailure }
      )
    )
  );
  await withProducer(
    `process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${childFailure}},()=>{process.exitCode=1;process.disconnect();});}); process.on("message",()=>{}); process.send({kind:"sources-ready"});`,
    async (owner) => {
      await owner.sourcesReady;
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
    `process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${cancellationGraph}},()=>{process.exitCode=1;process.disconnect();});}); process.on("message",()=>{}); process.send({kind:"sources-ready"});`,
    async (owner) => {
      await owner.sourcesReady;
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
    {
      code: "EOWNERSHIP",
    }
  );
  const graph = JSON.stringify(serializeRpcFailure(ownership));
  await withProducer(
    `process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${graph}},()=>{process.exitCode=1;process.disconnect();});}); process.on("message",()=>{}); process.send({kind:"sources-ready"});`,
    async (owner) => {
      await owner.sourcesReady;
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
    `process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${graph}},()=>{process.exitCode=1;process.disconnect();});}); process.on("message",()=>{}); process.send({kind:"sources-ready"});`,
    async (owner) => {
      await owner.sourcesReady;
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
      Object.assign(new Error("Template preparation cancelled"), { code: "ECANCELLED" })
    )
  );
  await withProducer(
    `process.on("SIGTERM",()=>{process.send({kind:"failed",failure:${cancellation}},()=>{process.exitCode=1;process.disconnect();});}); process.on("message",()=>{}); process.send({kind:"sources-ready"});`,
    async (owner) => {
      await owner.sourcesReady;
      await owner.stop();
    }
  );
});

void test("an exit without source publication settles readiness with a contract error", async () => {
  await withProducer(`process.disconnect();`, async (owner) => {
    await assert.rejects(owner.sourcesReady, /without publishing sources/);
    await assert.rejects(owner.completed, /without publishing sources/);
  });
});

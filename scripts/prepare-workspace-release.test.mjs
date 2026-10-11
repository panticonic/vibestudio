import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
    await owner?.stop();
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
    await withProducer(
      `${ready ? 'process.send({kind:"sources-ready"});' : ""} process.send({kind:"failed",message:"source build broke",code:"ECOMPILER"},()=>{process.exitCode=1;process.disconnect();});`,
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

void test("an exit without source publication settles readiness with a contract error", async () => {
  await withProducer(`process.disconnect();`, async (owner) => {
    await assert.rejects(owner.sourcesReady, /without publishing sources/);
    await assert.rejects(owner.completed, /without publishing sources/);
  });
});

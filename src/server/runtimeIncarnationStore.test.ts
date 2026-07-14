import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionArtifactRef,
  createSourceRevision,
  sha256,
  type BuildRecipe,
  type ExecutionArtifactRef,
} from "@vibestudio/shared/execution/identity";
import { RuntimeIncarnationStore } from "./runtimeIncarnationStore.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vs-runtime-incarnations-"));
  roots.push(value);
  return value;
}

function artifact(label: string): ExecutionArtifactRef {
  const digest = sha256("toolchain");
  const recipe: BuildRecipe = {
    target: "worker",
    platform: "workerd",
    architecture: "wasm32",
    abi: null,
    options: { label },
    toolchain: { digest, components: { workerd: digest } },
    dependencyGraph: { digest },
    builderDigest: digest,
    declaredEnvironment: {},
  };
  return createExecutionArtifactRef({
    source: createSourceRevision({
      repoPath: "workers/example",
      stateHash: sha256(`state:${label}`),
    }),
    recipe,
    entries: [
      {
        path: "bundle.js",
        role: "primary",
        mode: 0o644,
        contentType: "text/javascript",
        bytes: Buffer.from(label),
      },
    ],
  }).ref;
}

function prepare(store: RuntimeIncarnationStore, label: string, now: number) {
  const value = artifact(label);
  return store.prepare({
    logicalEntityId: "worker:workers/example:main",
    artifact: value,
    selectorPolicy: { kind: "artifact", executionDigest: value.executionDigest },
    compilationCacheKey: `cache:${label}`,
    actor:
      "code:workers/orchestrator@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    trigger: "launch",
    adoptionPolicy: { kind: "next-request" },
    now,
  });
}

describe("RuntimeIncarnationStore", () => {
  it("keeps the old incarnation authoritative until adoption commits atomically", () => {
    const store = new RuntimeIncarnationStore(root());
    const first = prepare(store, "first", 10);
    expect(store.getActive(first.incarnation.logicalEntityId)).toBeNull();
    store.adopt(first.transition.transitionId, 20);

    const candidate = prepare(store, "candidate", 30);
    expect(store.getActive(candidate.incarnation.logicalEntityId)?.artifact.executionDigest).toBe(
      first.incarnation.artifact.executionDigest
    );
    expect(candidate.transition.status).toBe("awaiting-adoption");

    const active = store.adopt(candidate.transition.transitionId, 40);
    expect(active.status).toBe("active");
    expect(store.getIncarnation(first.incarnation.incarnationId)).toMatchObject({
      status: "retired",
      endedAt: 40,
    });
    expect(store.listTransitions().at(-1)).toMatchObject({
      status: "committed",
      actor:
        "code:workers/orchestrator@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      committedAt: 40,
    });
  });

  it("records failed candidates without moving the active pointer", () => {
    const store = new RuntimeIncarnationStore(root());
    const first = prepare(store, "first", 10);
    store.adopt(first.transition.transitionId, 20);
    const candidate = prepare(store, "bad", 30);

    store.fail(candidate.transition.transitionId, { code: "STARTUP", message: "probe failed" }, 40);

    expect(store.getActive(candidate.incarnation.logicalEntityId)?.incarnationId).toBe(
      first.incarnation.incarnationId
    );
    expect(store.getIncarnation(candidate.incarnation.incarnationId)).toMatchObject({
      status: "failed",
      endedAt: 40,
    });
    expect(store.listTransitions().at(-1)).toMatchObject({
      status: "failed",
      error: { code: "STARTUP", message: "probe failed", failedAt: 40 },
    });
  });

  it("cancels a superseded candidate explicitly and recovers committed state cold", () => {
    const statePath = root();
    const store = new RuntimeIncarnationStore(statePath);
    const first = prepare(store, "first", 10);
    store.adopt(first.transition.transitionId, 20);
    const superseded = prepare(store, "second", 30);
    const latest = prepare(store, "third", 40);

    expect(
      store
        .listTransitions()
        .find((item) => item.transitionId === superseded.transition.transitionId)
    ).toMatchObject({ status: "cancelled" });
    expect(store.getIncarnation(superseded.incarnation.incarnationId)).toMatchObject({
      status: "retired",
      endedAt: 40,
    });
    store.adopt(latest.transition.transitionId, 50);

    const recovered = new RuntimeIncarnationStore(statePath);
    expect(recovered.getActive(latest.incarnation.logicalEntityId)?.incarnationId).toBe(
      latest.incarnation.incarnationId
    );
  });

  it("refuses the removed pre-refactor state format", () => {
    const statePath = root();
    const file = path.join(statePath, "runtime-incarnations.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, active: {}, incarnations: [], transitions: [] })
    );
    expect(() => new RuntimeIncarnationStore(statePath)).toThrow(
      "scoped runtime-foundations reset"
    );
  });
});

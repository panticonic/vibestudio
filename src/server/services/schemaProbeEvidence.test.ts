import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSchemaProbeEvidence,
  type SchemaProbeIdentity,
  type SchemaProbeDescriptor,
} from "./schemaProbeEvidence.js";
import {
  schemaProbeEnvironmentForFixture,
  useSchemaProbeFixtureCache,
} from "../../../tests/fixtures/schemaProbeEnvironment.js";

useSchemaProbeFixtureCache();
const identity: SchemaProbeIdentity = {
  artifactDigest: "a".repeat(64),
  source: "workers/example",
  className: "ExampleDO",
  installation: schemaProbeEnvironmentForFixture("actual owned fixture program"),
  protocol: 3,
  platform: "linux",
  arch: "x64",
  compatibility: {
    compatibilityDate: "2025-12-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "worker.js",
  },
};
const descriptor: SchemaProbeDescriptor = {
  className: "ExampleDO",
  version: 1,
  freshSchemaFingerprint: "canonical-fresh-schema",
  durableWorkQueues: [],
  nativeOwner: false,
};
const acquire = (
  probe: () => Promise<SchemaProbeDescriptor>,
  selected = identity,
  signal = new AbortController().signal
) => acquireSchemaProbeEvidence({ identity: selected, signal }, probe);
const cacheRoot = () =>
  path.join(process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"]!, "schema-probes");
const published = async () =>
  (await fs.readdir(cacheRoot())).filter((entry) => !entry.startsWith("."));

describe("immutable schema probe evidence", () => {
  it("reuses one exact descriptor without persisting workspace SQL or grants", async () => {
    const probe = vi.fn(async () => descriptor);
    expect(await acquire(probe)).toEqual(descriptor);
    expect(await acquire(probe)).toEqual(descriptor);
    expect(probe).toHaveBeenCalledOnce();
    const directories = await published();
    expect(directories).toHaveLength(1);
    const directory = path.join(cacheRoot(), directories[0]!);
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
    const receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
    expect(receipt).toEqual({ format: "vibestudio-schema-probe/1", identity, descriptor });
  });

  it("coalesces the same existing probe and publishes only after its retirement joins", async () => {
    let release!: () => void;
    const retired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = vi.fn(async () => {
      await retired;
      return descriptor;
    });
    const first = acquire(probe);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const second = acquire(probe);
    expect(await published()).toEqual([]);
    release();
    expect(await Promise.all([first, second])).toEqual([descriptor, descriptor]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it.each([
    "artifact",
    "source",
    "class",
    "host",
    "sdk",
    "protocol",
    "compatibility",
    "platform",
    "arch",
  ])("invalidates changed %s evidence", async (field) => {
    const changed = structuredClone(identity) as {
      -readonly [K in keyof SchemaProbeIdentity]: SchemaProbeIdentity[K];
    };
    if (field === "artifact") changed.artifactDigest = "b".repeat(64);
    if (field === "source") changed.source = "workers/another";
    if (field === "class") changed.className = "AnotherDO";
    if (field === "host")
      changed.installation = {
        ...changed.installation,
        hostBuild: { ...changed.installation.hostBuild, fingerprint: "b".repeat(64) },
      };
    if (field === "sdk")
      changed.installation = { ...changed.installation, appDependencyFingerprint: "b".repeat(64) };
    if (field === "protocol") changed.protocol++;
    if (field === "compatibility")
      changed.compatibility = { ...changed.compatibility, compatibilityDate: "2026-01-01" };
    if (field === "platform") changed.platform = "darwin";
    if (field === "arch") changed.arch = "arm64";
    await acquire(async () => descriptor);
    const probe = vi.fn(async () => ({ ...descriptor, className: changed.className }));
    await acquire(probe, changed);
    expect(probe).toHaveBeenCalledOnce();
    expect(await published()).toHaveLength(2);
  });

  it("preserves probe/retirement failure without publishing or leaving a staging attempt", async () => {
    const failure = new AggregateError(
      [new Error("probe failed"), new Error("retirement failed")],
      "owned probe failed"
    );
    await expect(
      acquire(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await published()).toEqual([]);
    expect((await fs.readdir(cacheRoot())).filter((entry) => entry.includes("publishing"))).toEqual(
      []
    );
  });

  it("joins admitted cancellation and does not publish the cancelled descriptor", async () => {
    const abort = new AbortController();
    const failure = new Error("manager shutdown");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = vi.fn(async () => {
      await held;
      return descriptor;
    });
    const pending = acquire(probe, identity, abort.signal);
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    abort.abort(failure);
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(await published()).toEqual([]);
  });

  it("cancels a waiting consumer without cancelling or retiring the elected probe", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = vi.fn(async () => {
      await held;
      return descriptor;
    });
    const producer = acquire(probe);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const abort = new AbortController();
    const pending = acquire(probe, identity, abort.signal);
    const failure = new Error("waiting manager shutdown");
    const rejected = expect(pending).rejects.toBe(failure);
    abort.abort(failure);
    await rejected;
    release();
    await expect(producer).resolves.toEqual(descriptor);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("rejects descriptor drift in a completed publication instead of probing another route", async () => {
    await acquire(async () => descriptor);
    const [entry] = await published();
    const file = path.join(cacheRoot(), entry!, "receipt.json");
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    receipt.descriptor.className = "wrong class";
    await fs.writeFile(file, JSON.stringify(receipt));
    const probe = vi.fn(async () => descriptor);
    await expect(acquire(probe)).rejects.toThrow("exact executable recipe");
    expect(probe).not.toHaveBeenCalled();
  });
});

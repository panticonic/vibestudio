import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSchemaProbeEvidence,
  type SchemaProbeIdentity,
  type SchemaProbeDescriptor,
  readInstalledSchemaProbeEvidence,
} from "./schemaProbeEvidence.js";
import {
  stageInstalledSchemaProbeEvidence,
  schemaProbeComponentPath,
} from "../../../scripts/lib/schema-probe-evidence.mjs";
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
  const stage = async () => {
    const output = path.join(cacheRoot(), "..", "installed");
    await fs.mkdir(output, { recursive: true });
    const publication = await stageInstalledSchemaProbeEvidence({
      source: cacheRoot(),
      output,
      installation: identity.installation,
      artifacts: [{ source: identity.source, artifactDigest: identity.artifactDigest }],
    });
    return { output, publication };
  };

  it("snapshots only advertised receipts while an owned publication is held", async () => {
    const rename = fs.rename.bind(fs);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).startsWith(cacheRoot()) && String(from).includes(".tmp.")) {
        entered();
        await held;
      }
      return rename(from, to);
    });
    const producer = acquire(async () => descriptor);
    await publicationEntered;
    let staged;
    try {
      staged = await stage();
      await staged.publication.publish();
      expect(
        (await readInstalledSchemaProbeEvidence(staged.output, identity.installation)).size
      ).toBe(0);
    } finally {
      release();
      await producer;
      await staged?.publication.close();
      spy.mockRestore();
    }
    expect(await published()).toHaveLength(1);
  });

  it("rejects unknown cache entries instead of treating arbitrary private-looking paths as misses", async () => {
    await acquire(async () => descriptor);
    await fs.mkdir(path.join(cacheRoot(), ".foreign"));
    await expect(stage()).rejects.toThrow(/foreign/);
  });

  it("publishes only proven immutable descriptors and reuses them without a mutable cache or probe", async () => {
    await acquire(async () => descriptor);
    const { output, publication } = await stage();
    try {
      expect(await readInstalledSchemaProbeEvidence(output, identity.installation)).toHaveProperty(
        "size",
        0
      );
      await publication.publish();
      const installed = await readInstalledSchemaProbeEvidence(output, identity.installation);
      if (process.platform !== "win32") {
        const source = path.join(cacheRoot(), (await published())[0]!, "receipt.json");
        expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(schemaProbeComponentPath(output))).mode & 0o777).toBe(0o644);
      }
      await fs.rm(cacheRoot(), { recursive: true });
      const probe = vi.fn(async () => descriptor);
      expect(
        await acquireSchemaProbeEvidence(
          { identity, installed, signal: new AbortController().signal },
          probe
        )
      ).toEqual(descriptor);
      expect(probe).not.toHaveBeenCalled();
      await expect(fs.stat(cacheRoot())).rejects.toMatchObject({ code: "ENOENT" });
      const component = JSON.parse(await fs.readFile(schemaProbeComponentPath(output), "utf8"));
      expect(component.receipts).toHaveLength(1);
      expect(component.receipts[0]).toEqual({
        format: "vibestudio-schema-probe/1",
        identity,
        descriptor,
      });
      await expect(publication.publish()).resolves.toBeUndefined();
    } finally {
      await publication.close();
    }
  });

  it("uses the canonical mutable producer for an unadvertised changed artifact", async () => {
    await acquire(async () => descriptor);
    const { output, publication } = await stage();
    try {
      await publication.publish();
      const installed = await readInstalledSchemaProbeEvidence(output, identity.installation);
      const probe = vi.fn(async () => descriptor);
      await acquireSchemaProbeEvidence(
        {
          identity: { ...identity, artifactDigest: "b".repeat(64) },
          installed,
          signal: new AbortController().signal,
        },
        probe
      );
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      await publication.close();
    }
  });

  it("re-verifies the sealed installed inventory without a mutable cache or incidental expansion", async () => {
    await acquire(async () => descriptor);
    const first = await stage();
    try {
      await first.publication.publish();
    } finally {
      await first.publication.close();
    }
    const original = await fs.readFile(schemaProbeComponentPath(first.output));
    // An additional valid proof is not a request to mutate this installation.
    await acquire(async () => descriptor, { ...identity, artifactDigest: "b".repeat(64) });
    const repeat = await stage();
    try {
      await repeat.publication.publish();
    } finally {
      await repeat.publication.close();
    }
    expect(await fs.readFile(schemaProbeComponentPath(first.output))).toEqual(original);
    await fs.rm(cacheRoot(), { recursive: true });
    const withoutCache = await stage();
    try {
      await withoutCache.publication.publish();
    } finally {
      await withoutCache.publication.close();
    }
    expect(await fs.readFile(schemaProbeComponentPath(first.output))).toEqual(original);
    await expect(
      stageInstalledSchemaProbeEvidence({
        source: cacheRoot(),
        output: first.output,
        installation: identity.installation,
        artifacts: [],
      })
    ).rejects.toThrow(/published runtime artifact/);
  });

  it.each(["missing", "duplicate", "class", "installation", "malformed"])(
    "rejects %s advertised installed evidence without reprobe",
    async (corruption) => {
      await acquire(async () => descriptor);
      const { output, publication } = await stage();
      try {
        await publication.publish();
        const filename = schemaProbeComponentPath(output);
        const component = JSON.parse(await fs.readFile(filename, "utf8"));
        if (corruption === "missing") component.receipts = [];
        if (corruption === "duplicate") component.receipts.push(component.receipts[0]);
        if (corruption === "class") component.receipts[0].descriptor.className = "OtherDO";
        if (corruption === "installation")
          component.installation.appDependencyFingerprint = "b".repeat(64);
        await fs.writeFile(
          filename,
          corruption === "malformed" ? "not-json" : JSON.stringify(component)
        );
        await expect(
          readInstalledSchemaProbeEvidence(output, identity.installation)
        ).rejects.toThrow();
      } finally {
        await publication.close();
      }
    }
  );

  it("cancels staged installed publication without advertising evidence", async () => {
    await acquire(async () => descriptor);
    const output = path.join(cacheRoot(), "..", "installed");
    await fs.mkdir(output);
    const cancellation = new AbortController();
    const publication = await stageInstalledSchemaProbeEvidence({
      source: cacheRoot(),
      output,
      installation: identity.installation,
      artifacts: [{ source: identity.source, artifactDigest: identity.artifactDigest }],
      signal: cancellation.signal,
    });
    const reason = new Error("release retired");
    cancellation.abort(reason);
    try {
      await expect(publication.publish()).rejects.toBe(reason);
    } finally {
      await publication.close();
    }
    expect(await fs.readdir(output)).toEqual([]);
  });
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
    expect((await fs.readdir(cacheRoot())).filter((entry) => entry.includes(".tmp."))).toEqual([]);
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

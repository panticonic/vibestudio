import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  CREDENTIALS_MEMBERS,
  GAD_MEMBERS,
  portableExports,
  VCS_MEMBERS,
  WEBHOOKS_MEMBERS,
} from "./runtimeSurface.portable.js";
import { vcsMethods } from "../vcs.js";

describe("runtime surface schemaRef parity", () => {
  it("every schemaRef resolves to a service-schemas source file", () => {
    const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = new Set(readdirSync(schemaDir));
    const dangling: string[] = [];
    for (const [name, entry] of Object.entries(portableExports)) {
      const ref = entry.schemaRef;
      if (ref && !files.has(`${ref}.ts`)) dangling.push(`${name} → ${ref}`);
    }
    expect(
      dangling,
      `runtime-surface schemaRef must name a service-schemas file: ${dangling.join(", ")}`
    ).toEqual([]);
  });

  it("documents the credential runtime API without linking to its internal wire transport", () => {
    const credentials = portableExports["credentials"];
    if (!credentials) throw new Error("missing credentials runtime surface");
    expect(credentials.members).toEqual(CREDENTIALS_MEMBERS);
    expect(credentials.members).toContain("fetch");
    expect(credentials.members).not.toContain("proxyFetch");
    expect(credentials.schemaRef).toBeUndefined();
    expect(credentials.description).toContain("fetch(url, init?, { credentialId? }?)");
  });

  it("carries generated typed docs for every GAD runtime method", () => {
    const gad = portableExports["gad"];
    if (!gad) throw new Error("missing GAD runtime surface");
    expect(gad.members).toEqual(GAD_MEMBERS);
    expect(Object.keys(gad.methodCatalog ?? {})).toEqual(GAD_MEMBERS);
    expect(gad.methodCatalog?.["query"]).toMatchObject({
      description: expect.stringContaining("read-oriented SQL query"),
      argsSchema: expect.any(Object),
      returnsSchema: expect.any(Object),
    });
  });

  it("derives the documented VCS namespace from the canonical semantic registry", () => {
    const vcs = portableExports["vcs"];
    if (!vcs) throw new Error("missing VCS runtime surface");
    expect(VCS_MEMBERS).toEqual(Object.keys(vcsMethods));
    expect(vcs.members).toEqual(Object.keys(vcsMethods));
    expect(vcs.members).toContain("integrate");
    expect(vcs.members).toContain("move");
    expect(vcs.members).toContain("neighbors");
    expect(vcs.members).not.toContain("moveFiles");
  });

  it("documents the ergonomic webhook lifecycle without exposing its raw transport", () => {
    const webhooks = portableExports["webhooks"];
    if (!webhooks) throw new Error("missing webhooks runtime surface");
    expect(webhooks.members).toEqual(WEBHOOKS_MEMBERS);
    expect(webhooks.schemaRef).toBe("webhookIngress");
    expect(webhooks.description).toContain("rotateSecret(subscriptionId, secret?)");
    expect(webhooks.description).toContain("agent eval");
  });
});

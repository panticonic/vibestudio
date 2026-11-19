import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCliIdentity } from "../cli/credentialStore.js";
import { RpcClient } from "../cli/rpcClient.js";
import { requireDevelopmentTemplateCheckout } from "./developmentTemplateConfig.js";
import type { DevInstanceRecord } from "./instanceRegistry.js";
import { isManagedSystemTestInstance } from "./systemTestInstance.js";

const prefix = "integration-readiness-live-";
const qualification = "integration-readiness-oracle-qualification";

export async function seedIntegrationReadinessFixture(
  instance: DevInstanceRecord,
  command: readonly string[],
  signal: AbortSignal
) {
  if (
    command[0] !== "run" ||
    !command.some((arg) => arg === qualification || arg.startsWith(prefix))
  )
    return;

  const checkout = requireDevelopmentTemplateCheckout(instance.repoRoot, "system-testing");
  const source = path.join(checkout, "skills/system-testing/integration-readiness-worlds.ts");
  const { integrationReadinessFixture: fixture, managedIntegrationReadinessWorlds: worlds } =
    (await import(pathToFileURL(source).href)) as {
      integrationReadinessFixture: { audience: string; label: string };
      managedIntegrationReadinessWorlds: { id: string }[];
    };
  if (!command.includes(qualification) && !worlds.some(({ id }) => command.includes(prefix + id)))
    return;
  if (!isManagedSystemTestInstance(instance) || instance.lifecycle !== "ephemeral")
    throw new Error("The synthetic integration binding needs a disposable managed instance");
  const audience = new URL(fixture.audience);
  if (
    audience.protocol !== "https:" ||
    !audience.hostname.endsWith(".system-test.invalid") ||
    audience.username ||
    audience.password ||
    audience.search ||
    audience.hash
  )
    throw new Error("The integration fixture must bind a reserved test URL");

  const identity = loadCliIdentity(path.join(instance.root, "cli-credentials.json"));
  if (
    identity?.kind !== "device" ||
    identity.phase !== "workspace" ||
    identity.transport !== "local"
  )
    throw new Error("The disposable integration fixture needs its paired local device");
  const client = new RpcClient(identity, { signal });
  const read = () =>
    client.mainCall("credentials.resolveCredential", [{ url: fixture.audience, use: "fetch" }]);
  try {
    const existing = await read();
    if (existing) {
      if (existing.label !== fixture.label || existing.lifecycle.state !== "active")
        throw new Error("An unexpected binding matches the reserved fixture audience");
      return;
    }
    try {
      await client.mainCall("credentials.storeCredential", [
        {
          label: fixture.label,
          audience: [{ url: fixture.audience, match: "path-prefix" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "synthetic-integration-fixture" },
        },
      ]);
    } catch (error) {
      // An exact fixture may have been seeded by another invocation on this instance.
      signal.throwIfAborted();
      const current = await read();
      if (current?.label !== fixture.label || current.lifecycle.state !== "active") throw error;
    }
  } finally {
    await client.close();
  }
}

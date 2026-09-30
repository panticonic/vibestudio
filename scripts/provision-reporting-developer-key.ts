/** Provision the private report API without placing its bearer in the workspace. */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { CredentialStore } from "../packages/credential-client/src/store.js";

const credentialId = "vibestudio-reporting-developer";
const label = "Vibestudio reporting developer";
const store = new CredentialStore();
const existing = await store.loadUrlBound(credentialId);
const token = existing?.accessToken ?? randomBytes(32).toString("hex");
if (!/^[a-f0-9]{64}$/.test(token)) {
  throw new Error("The existing developer credential has invalid material; rotate it explicitly");
}

if (!existing) {
  await store.saveUrlBound({
    id: credentialId,
    providerId: "url-bound",
    connectionId: credentialId,
    connectionLabel: label,
    label,
    owner: { sourceId: "reporting-developer", sourceKind: "user", label },
    accountIdentity: { providerUserId: "reporting-developer" },
    accessToken: token,
    scopes: ["reporting:admin"],
    bindings: [
      {
        id: "fetch",
        use: "fetch",
        audience: [
          { url: "https://vibestudio.app/v1/problem-reports/admin", match: "path-prefix" },
        ],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
        },
      },
    ],
  });
}

const digest = createHash("sha256").update(token).digest("hex");
const child = spawn(
  "pnpm",
  ["exec", "wrangler", "secret", "put", "REPORT_KEYS", "--config", "apps/webhook-relay/wrangler.toml"],
  { stdio: ["pipe", "inherit", "inherit"] }
);
child.stdin.end(JSON.stringify([{ id: credentialId, digest }]));
const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) throw new Error(`Wrangler secret provisioning failed (${exitCode})`);
console.log(`Developer credential ${credentialId} is in the external encrypted credential store.`);

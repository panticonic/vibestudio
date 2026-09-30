import { CredentialStore } from "../packages/credential-client/src/store.js";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  encodeReport,
  reportDigest,
  reportSignaturePayload,
  REPORT_MEDIA_TYPE,
} from "../packages/service-schemas/src/problemReportBundle.js";
import { reportFixture } from "../src/server/problemReporting/testFixture.js";

const credential = await new CredentialStore().loadUrlBound("vibestudio-reporting-developer");
if (!credential) throw new Error("Provision the developer key first");
const base = "https://vibestudio.app";
for (const [label, path, init, expected] of [
  ["apex", "/", {}, 200],
  ["private API without key", "/v1/problem-reports/admin/overview", {}, 401],
  [
    "private API with key",
    "/v1/problem-reports/admin/overview",
    { headers: { authorization: `Bearer ${credential.accessToken}` } },
    200,
  ],
  ["anonymous startup count", "/v1/problem-reports/usage/startup", { method: "POST" }, 204],
] as const) {
  const response = await fetch(`${base}${path}`, init);
  console.log(`${label}: ${response.status}`);
  if (response.status !== expected) {
    console.error((await response.text()).slice(0, 500));
    process.exitCode = 1;
  }
}

if (process.argv.includes("--write-test-report")) {
  const report = reportFixture();
  const bytes = encodeReport(report);
  const digest = await reportDigest(bytes);
  const receiptSecret = randomBytes(32).toString("hex");
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
    "hex"
  );
  const signature = sign(
    null,
    reportSignaturePayload(report.submissionId, digest, await reportDigest(receiptSecret)),
    pair.privateKey
  ).toString("hex");
  const headers = {
    "content-type": REPORT_MEDIA_TYPE,
    "x-report-submission-id": report.submissionId,
    "x-report-digest": digest,
    "x-report-receipt-secret": receiptSecret,
    "x-report-public-key": publicKey,
    "x-report-signature": signature,
  };
  try {
    const accepted = await fetch(`${base}/v1/problem-reports`, {
      method: "POST",
      headers,
      body: bytes,
    });
    console.log(`signed test report: ${accepted.status}`);
    if (accepted.status !== 201) throw new Error((await accepted.text()).slice(0, 500));
    const retrieved = await fetch(
      `${base}/v1/problem-reports/admin/reports/${report.submissionId}/bundle`,
      { headers: { authorization: `Bearer ${credential.accessToken}` } }
    );
    console.log(`developer bundle read: ${retrieved.status}`);
    if (retrieved.status !== 200 || (await retrieved.text()) !== bytes)
      throw new Error("Uploaded report was not readable from private storage");
  } finally {
    const deleted = await fetch(`${base}/v1/problem-reports/submissions/${report.submissionId}`, {
      method: "DELETE",
      headers: { "x-report-receipt-secret": receiptSecret },
    });
    console.log(`test report deletion: ${deleted.status}`);
    if (deleted.status !== 200) process.exitCode = 1;
  }
}

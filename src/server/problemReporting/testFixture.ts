import { randomUUID } from "node:crypto";
import type { ProblemReportBundle } from "@vibestudio/service-schemas/problemReportBundle";
import { REPORT_POLICY } from "@vibestudio/service-schemas/problemReportBundle";
export function reportFixture(overrides: Partial<ProblemReportBundle> = {}): ProblemReportBundle {
  const at = new Date().toISOString();
  return {
    schema: "vibestudio.problem-report.v1",
    submissionId: randomUUID(),
    reportId: randomUUID(),
    reportRevision: 1,
    intent: "manual-problem",
    createdAt: at,
    observedAt: at,
    consent: {
      policyVersion: REPORT_POLICY.version,
      revision: 1,
      mode: "manual",
      approvedAt: at,
      destination: REPORT_POLICY.destination,
    },
    environment: {
      productVersion: "0.1.52",
      buildVersion: null,
      templateVersion: null,
      platform: "linux",
      architecture: "x64",
      runtime: "server",
    },
    problem: {
      category: "runtime",
      component: "rpc",
      operation: "runtime.test",
      code: "INTERNAL_ERROR",
      kind: "internal",
      frames: [],
      externalFramesOmitted: 0,
    },
    occurrence: {
      origin: randomUUID(),
      fingerprint: "a".repeat(64),
      fingerprintVersion: 1,
      count: 1,
      firstAt: at,
      lastAt: at,
      dropped: 0,
      sampled: false,
    },
    references: [],
    narrative: [],
    evidence: [],
    attachments: [],
    ...overrides,
  };
}

import { createHash, randomUUID } from "node:crypto";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { callerAccountUserId } from "@vibestudio/shared/serviceDispatcher";
import { rpcErrorKindOf } from "@vibestudio/rpc";
import {
  REPORT_POLICY,
  encodeReport,
  type ProblemReportBundle,
  type ReportProblem,
} from "@vibestudio/service-schemas/problemReportBundle";
import { canonicalJson } from "@vibestudio/content-addressing";
import { ProblemReportingStore } from "./store";
export class ReportCapture {
  private pending: { owner: string; problem: ReportProblem; origin: string; at: string }[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dropped = 0;
  constructor(
    private readonly store: ProblemReportingStore,
    private readonly workspaceId: string,
    private readonly wake: () => void,
    private readonly options: {
      runtime?: ProblemReportBundle["environment"]["runtime"];
      owner?: () => string | null;
      productVersion?: string;
    } = {}
  ) {}
  serviceFailure(failure: {
    ctx: ServiceContext;
    service: string;
    method: string;
    error: unknown;
    diagnosticId: string;
  }): void {
    if (failure.service === "problemReports") return;
    const owner = callerAccountUserId(failure.ctx.caller) ?? this.options.owner?.();
    if (!owner) return;
    const kind = rpcErrorKindOf(failure.error, "internal");
    // Free-text errors remain local. Only host-normalized product diagnostic fields enter automatic bundles.
    const problem: ReportProblem = {
      category: "service",
      component: "rpc",
      operation: [
        "runtime",
        "vcs",
        "build",
        "workspace",
        "workspaceState",
        "fs",
        "gateway",
        "app",
        "view",
      ].includes(failure.service)
        ? `${failure.service}.${failure.method}`
        : null,
      code: null,
      kind: kind === "service" ? "application" : kind,
      frames: [],
      externalFramesOmitted: 0,
    };
    this.observe(owner, problem, failure.diagnosticId);
  }
  observe(
    owner: string,
    problem: ReportProblem,
    origin: string = randomUUID(),
    at = new Date().toISOString()
  ): void {
    const input = { owner, problem, origin, at };
    const size = Buffer.byteLength(JSON.stringify(input));
    if (size > 16384 || this.pending.length >= 256 || this.bytes + size > 1048576) {
      this.dropped++;
      return;
    }
    this.pending.push(input);
    this.bytes += size;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, 0);
      this.timer.unref();
    }
  }
  flush(): void {
    const pending = this.pending;
    this.pending = [];
    this.bytes = 0;
    for (const observation of pending)
      try {
        const { owner, problem, origin, at } = observation;
        const fingerprint = createHash("sha256")
          .update(
            canonicalJson({
              version: 1,
              component: problem.component,
              operation: problem.operation,
              code: problem.code,
              kind: problem.kind,
              frames: problem.frames,
            })
          )
          .digest("hex");
        const retained = this.store.observe(
          owner,
          this.workspaceId,
          origin,
          fingerprint,
          JSON.stringify(problem),
          at
        );
        if (!retained.added) continue;
        const consent = this.store.consent(owner);
        if (
          consent.state !== "on" ||
          !(
            ["internal", "protocol"].includes(problem.kind) ||
            (problem.kind === "application" && ["runtime", "build"].includes(problem.category))
          ) ||
          !consent.decidedAt ||
          at <= consent.decidedAt
        )
          continue;
        const now = new Date().toISOString();
        const report: ProblemReportBundle = {
          schema: "vibestudio.problem-report.v1",
          submissionId: randomUUID(),
          reportId: randomUUID(),
          reportRevision: 1,
          intent: "automatic-diagnostic",
          createdAt: now,
          observedAt: at,
          consent: {
            policyVersion: REPORT_POLICY.version,
            revision: consent.revision,
            mode: "automatic",
            approvedAt: consent.decidedAt,
            destination: REPORT_POLICY.destination,
          },
          environment: {
            productVersion: this.options.productVersion ?? null,
            buildVersion: null,
            templateVersion: null,
            platform:
              process.platform === "linux" ||
              process.platform === "darwin" ||
              process.platform === "win32"
                ? process.platform
                : "unknown",
            architecture:
              process.arch === "x64" || process.arch === "arm64" ? process.arch : "unknown",
            runtime: this.options.runtime ?? "server",
          },
          problem,
          occurrence: {
            origin,
            fingerprint,
            fingerprintVersion: 1,
            count: 1,
            firstAt: at,
            lastAt: at,
            dropped: this.dropped,
            sampled: this.dropped > 0,
            installationPseudonym: consent.pseudonym!,
          },
          references: [],
          narrative: [],
          evidence: [],
          attachments: [],
        };
        encodeReport(report);
        this.store.create(owner, this.workspaceId, report);
        const prepared = this.store.prepare(owner, this.workspaceId, report.reportId, 1);
        try {
          this.store.queue(owner, this.workspaceId, report.reportId, 1, prepared.digest);
          this.wake();
        } catch {
          this.store.deleteLocal(owner, this.workspaceId, report.reportId, true);
        }
      } catch {
        this.dropped++;
        process.stderr.write(
          "[problem-reporting] Observation could not be retained; capture loss counted.\n"
        );
      }
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}

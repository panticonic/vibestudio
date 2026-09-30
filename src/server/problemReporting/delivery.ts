import { createHash } from "node:crypto";
import { createMachineReportSigner, type ReportSigner } from "./signing";
import { z } from "zod";
import { rpcErrorKindOf } from "@vibestudio/rpc";
class IntegrityError extends Error {}
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  ProblemReportReceiptSchema,
  REPORT_MEDIA_TYPE,
  REPORT_POLICY,
} from "@vibestudio/service-schemas/problemReportBundle";
import type { EgressProxy } from "../services/egressProxy";
import { ProblemReportingStore } from "./store";
export class ReportDelivery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private maintenanceAt = 0;
  constructor(
    private readonly store: ProblemReportingStore,
    private readonly egress: Pick<EgressProxy, "forwardHostFetch">,
    private readonly signer: ReportSigner = createMachineReportSigner()
  ) {}
  wake(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) {
        this.active = this.run()
          .catch(() => {
            /* Bounded retry after a local maintenance/claim failure. */
          })
          .finally(() => {
            this.active = null;
            if (!this.stopped) this.schedule();
          });
      }
    }, 0);
    this.timer.unref();
  }
  private schedule(): void {
    if (this.timer || this.stopped) return;
    const due = this.store.nextDeliveryAt();
    const delay = due === null ? 60000 : Math.max(0, Math.min(60000, due - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, delay);
    this.timer.unref();
  }
  abortActive(): void {
    this.controller?.abort();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
  private async run(): Promise<void> {
    if (Date.now() - this.maintenanceAt > 3600000) {
      this.store.maintenance();
      this.maintenanceAt = Date.now();
    }
    const row = this.store.claim();
    if (!row) return;
    const id = String(row["id"]),
      lease = String(row["lease"]);
    const connection = this.store.ownerSubject(String(row["owner"]));
    if (!connection) {
      this.store.finish(id, lease, "paused", "reporting-access-unavailable");
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 30000);
    deadline.unref();
    const headers = { "x-report-receipt-secret": String(row["receipt_secret"]) };
    const send = (method: string, url: string, extra: Record<string, string> = {}, body?: string) =>
      this.egress.forwardHostFetch({
        caller: createHostCaller(`problem-reports:${connection.owner}`, "server", {
          userId: connection.owner,
          handle: connection.handle,
        }),
        operation: {
          service: "problemReports",
          method: "deliver",
          resourceKey: id,
          preparedStateDigest: String(row["digest"]),
        },
        url,
        method,
        headers: { ...headers, ...extra },
        body,
        credentialId: null,
        signal: controller.signal,
        responseByteLimit: 16 * 1024,
      });
    const recordReceipt = (response: { body: Uint8Array }) => {
      const receipt = ProblemReportReceiptSchema.parse(
        JSON.parse(new TextDecoder().decode(response.body))
      );
      if (receipt.submissionId !== id || receipt.digest !== row["digest"])
        throw new IntegrityError("Receipt integrity mismatch");
      this.store.finish(id, lease, "received", null, Date.now(), JSON.stringify(receipt));
    };
    try {
      // Recovery on every retry uses the pre-generated secret; auth failure/nonexistence cannot prove acceptance.
      if (Number(row["attempts"]) > 1) {
        const status = await send("GET", `${REPORT_POLICY.destination}/submissions/${id}/status`);
        if (status.status === 200) {
          recordReceipt(status);
          return;
        }
      }
      if (!this.store.dispatchAllowed(id, lease)) {
        this.store.finish(id, lease, "cancelled", "consent-withdrawn");
        return;
      }
      const signature = row["signature"]
        ? { publicKey: String(row["signing_public_key"]), signature: String(row["signature"]) }
        : this.store.recordSignature(
            id,
            lease,
            await this.signer(
              id,
              String(row["digest"]),
              createHash("sha256").update(String(row["receipt_secret"])).digest("hex")
            )
          );
      const response = await send(
        "POST",
        REPORT_POLICY.destination,
        {
          "content-type": REPORT_MEDIA_TYPE,
          "x-report-submission-id": id,
          "x-report-digest": String(row["digest"]),
          "x-report-public-key": signature.publicKey,
          "x-report-signature": signature.signature,
        },
        this.store.bytes(row)
      );
      if (response.status === 200 || response.status === 201) {
        recordReceipt(response);
        return;
      }
      if ([401, 403].includes(response.status)) {
        this.store.finish(id, lease, "paused", "reporting-access-unavailable");
        return;
      }
      if ([400, 409, 413, 415, 422, 301, 302, 303, 307, 308].includes(response.status)) {
        this.store.finish(id, lease, "rejected", `intake-${response.status}`);
        return;
      }
      const retryHeader = new Headers(response.headerPairs).get("retry-after");
      let retry = retryHeader ? Number(retryHeader) * 1000 : 0;
      if (!Number.isFinite(retry)) retry = Math.max(0, Date.parse(retryHeader!) - Date.now());
      this.retry(row, id, lease, `http-${response.status}`, retry);
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof IntegrityError
      ) {
        this.store.finish(id, lease, "rejected", "receipt-invalid");
        return;
      }
      if (
        rpcErrorKindOf(error) === "access" ||
        (typeof error === "object" && error !== null && "code" in error && error.code === "EACCES")
      ) {
        this.store.finish(id, lease, "paused", "reporting-access-unavailable");
        return;
      }
      this.retry(
        row,
        id,
        lease,
        error instanceof z.ZodError ? "receipt-invalid" : "transport-unavailable"
      );
    } finally {
      clearTimeout(deadline);
      if (this.controller === controller) this.controller = null;
    }
  }
  private retry(
    row: Record<string, unknown>,
    id: string,
    lease: string,
    reason: string,
    minimum = 0
  ): void {
    const delay = Math.min(3600000, 5000 * 2 ** Math.min(10, Number(row["attempts"]) - 1));
    this.store.finish(
      id,
      lease,
      "queued",
      reason,
      Date.now() + Math.max(minimum, delay * (0.5 + Math.random() / 2))
    );
  }
}

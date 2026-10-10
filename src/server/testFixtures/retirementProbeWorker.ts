import { dispatchRpcCall } from "@vibestudio/rpc/internal";
import {
  DurableObjectBase,
  rpc,
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
} from "@vibestudio/durable";
import { docsMethods } from "@vibestudio/service-schemas/docs";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

/** A real domain callback must remain serviceable until terminal release joins. */
export class RetirementProbeDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec("CREATE TABLE domain_release (id INTEGER PRIMARY KEY, state TEXT NOT NULL)");
    this.sql.exec("INSERT INTO domain_release VALUES (1, 'owned')");
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
    website: { kind: "closed", reason: "Retirement domain fixture." },
  })
  completeDomainReceipt(): void {
    this.ensureReady();
    const state = this.sql.exec("SELECT state FROM domain_release WHERE id = 1").toArray()[0]?.[
      "state"
    ];
    if (state !== "owned") throw new Error("Domain receipt has no outstanding operation");
    this.sql.exec("UPDATE domain_release SET state = 'terminal' WHERE id = 1");
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
    website: { kind: "closed", reason: "Retirement domain fixture." },
  })
  domainState(): string {
    this.ensureReady();
    return String(
      this.sql.exec("SELECT state FROM domain_release WHERE id = 1").toArray()[0]?.["state"]
    );
  }

  override async releaseForLifecycle(
    input: LifecyclePrepareInput
  ): Promise<LifecyclePrepareResult> {
    if (input.mode !== "retire") throw new Error("Retirement probe requires terminal release");
    // Capture phases preserve the domain operation; only final resource release
    // cancels it and joins its authoritative terminal receipt.
    if (input.phase !== "release") return { status: "ready" };
    // The host callback returns only after the authoritative receiver receipt.
    // No elapsed-time completion or local manufactured cancellation is used.
    const docs = createTypedServiceClient("docs", docsMethods, (service, method, args) =>
      dispatchRpcCall(this.rpc, "main", `${service}.${method}`, args)
    );
    await docs.listServices();
    if (this.domainState() !== "terminal") throw new Error("Domain release is unconfirmed");
    this.sql.exec("UPDATE domain_release SET state = 'released' WHERE id = 1");
    return { status: "ready" };
  }
}

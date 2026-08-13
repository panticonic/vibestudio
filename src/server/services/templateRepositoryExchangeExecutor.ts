import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { VcsImportSnapshotResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { canonicalJson } from "@vibestudio/content-addressing";
import {
  applyPreparedTemplateRepositoryExchangeTarget,
  completeTemplateRepositoryExchange,
  planTemplateRepositoryExchange,
  prepareTemplateRepositoryExchangeTarget,
  type ExchangeDirection,
  type ExchangeReceipt,
  type PendingTemplateExchange,
  type TemplateExchangePlan,
} from "@vibestudio/workspace/templateRepositoryExchange";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";
import {
  scanNativeSnapshot,
  type NativeDevelopmentSemanticAdapter,
  type NativeDevelopmentSemanticIngress,
} from "./nativeDevelopmentExecutor.js";

interface Marker {
  version: 1;
  operationId: string;
  intentDigest: string;
  direction: ExchangeDirection;
  checkout: string;
  contextId: string;
  repositoryId: string;
  expectedWorkingHead: VcsStateNodeRef;
  sourcePlanDigest: string;
  repoPath: string;
  plan: TemplateExchangePlan;
  pending: null | {
    baseline: Array<{ path: string; base64: string; mode: number; digest: string }>;
    written: PendingTemplateExchange["written"];
    deleted: string[];
    preserved: string[];
  };
  receipt: TemplateExchangeApplyReceipt | null;
}

export type TemplateExchangeApplyReceipt =
  | { direction: "export"; exchange: ExchangeReceipt; imported: null }
  | { direction: "import"; exchange: ExchangeReceipt; imported: VcsImportSnapshotResult };

export class TemplateRepositoryExchangeExecutor {
  constructor(
    private readonly deps: {
      root: string;
      blobsDir: string;
      planSource(input: {
        contextId: string;
        repositoryId: string;
        requiredFiles: readonly string[];
      }): Promise<ExactRepositorySnapshotPlan>;
      materializeSource(plan: ExactRepositorySnapshotPlan, destination: string): Promise<void>;
      semantic: NativeDevelopmentSemanticAdapter;
    }
  ) {}

  async prepare(input: {
    direction: ExchangeDirection;
    checkout: string;
    contextId: string;
    repositoryId: string;
    expectedWorkingHead: VcsStateNodeRef;
    idempotencyKey: string;
  }): Promise<{ intentDigest: string; plan: TemplateExchangePlan }> {
    const checkout = await exactCheckout(input.checkout);
    const intent = { ...input, checkout };
    const intentDigest = hash(canonicalJson(intent));
    const operationRoot = path.join(this.deps.root, intentDigest);
    const markerPath = path.join(operationRoot, "operation.json");
    try {
      const existing = await readMarker(markerPath);
      if (existing.intentDigest !== intentDigest)
        throw coded("EIDEMPOTENCYDRIFT", "Exchange intent changed");
      return { intentDigest, plan: existing.plan };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(operationRoot, { recursive: false, mode: 0o700 });
    try {
      const semanticRoot = path.join(operationRoot, "semantic");
      await fs.mkdir(semanticRoot, { mode: 0o700 });
      const sourcePlan = await this.deps.planSource({
        contextId: input.contextId,
        repositoryId: input.repositoryId,
        requiredFiles: ["meta/template.yml"],
      });
      if (
        sourcePlan.contextId !== input.contextId ||
        sourcePlan.repositoryId !== input.repositoryId
      ) {
        throw coded("EIDENTITYDRIFT", "Semantic template repository identity changed");
      }
      await this.deps.materializeSource(sourcePlan, semanticRoot);
      const plan = planTemplateRepositoryExchange({
        workspace: semanticRoot,
        checkout,
        direction: input.direction,
      });
      const marker: Marker = {
        version: 1,
        operationId: plan.operationId,
        intentDigest,
        direction: input.direction,
        checkout,
        contextId: input.contextId,
        repositoryId: input.repositoryId,
        expectedWorkingHead: input.expectedWorkingHead,
        sourcePlanDigest: sourcePlan.planDigest,
        repoPath: sourcePlan.repoPath,
        plan,
        pending: null,
        receipt: null,
      };
      await writeMarker(markerPath, marker);
      return { intentDigest, plan };
    } catch (error) {
      await fs.rm(operationRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async apply(input: {
    operationId: string;
    intentDigest: string;
    checkout: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<TemplateExchangeApplyReceipt> {
    const operationRoot = path.join(this.deps.root, input.intentDigest);
    assertWithin(this.deps.root, operationRoot);
    const markerPath = path.join(operationRoot, "operation.json");
    let marker = await readMarker(markerPath);
    if (marker.operationId !== input.operationId || marker.intentDigest !== input.intentDigest) {
      throw coded("EIDEMPOTENCYDRIFT", "Exchange apply does not match its reviewed plan");
    }
    if ((await exactCheckout(input.checkout)) !== marker.checkout) {
      throw coded("EIDEMPOTENCYDRIFT", "Exchange checkout does not match its reviewed plan");
    }
    if (marker.receipt) return marker.receipt;
    let pending = marker.pending ? decodePending(marker.pending) : null;
    if (!pending) {
      pending = prepareTemplateRepositoryExchangeTarget(marker.plan);
      marker = { ...marker, pending: encodePending(pending) };
      await writeMarker(markerPath, marker);
    }
    applyPreparedTemplateRepositoryExchangeTarget(marker.plan, pending);
    let imported: VcsImportSnapshotResult | null = null;
    if (marker.direction === "import") {
      const descriptor = await scanNativeSnapshot({
        repositoryRoot: marker.plan.target,
        repositoryId: marker.repositoryId,
        repoPath: marker.repoPath,
        sessionId: `template-exchange-${marker.operationId}`,
        blobsDir: this.deps.blobsDir,
        persist: true,
      });
      imported = await this.deps.semantic.importSnapshot({
        developmentContextId: marker.contextId,
        repositoryId: marker.repositoryId,
        expectedWorkingHead: marker.expectedWorkingHead,
        commandId: `template-exchange:${marker.operationId}`,
        descriptor,
        ingress: input.ingress,
      });
    }
    const exchange = completeTemplateRepositoryExchange(marker.plan, pending);
    const receipt: TemplateExchangeApplyReceipt =
      marker.direction === "export"
        ? { direction: "export", exchange, imported: null }
        : { direction: "import", exchange, imported: imported! };
    marker = { ...marker, receipt };
    await writeMarker(markerPath, marker);
    await fs.rm(path.join(operationRoot, "semantic"), { recursive: true, force: true });
    await this.reapCompleted(input.intentDigest);
    return receipt;
  }

  private async reapCompleted(currentIntentDigest: string): Promise<void> {
    const entries = await fs.readdir(this.deps.root, { withFileTypes: true });
    const completed: Array<{ root: string; completedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentIntentDigest) continue;
      const root = path.join(this.deps.root, entry.name);
      try {
        const marker = await readMarker(path.join(root, "operation.json"));
        if (marker.receipt)
          completed.push({ root, completedAt: Date.parse(marker.receipt.exchange.completedAt) });
      } catch {
        // An incomplete or corrupt operation is never deleted by ambient cleanup.
      }
    }
    const expired = completed.sort((left, right) => right.completedAt - left.completedAt).slice(31);
    await Promise.all(expired.map(({ root }) => fs.rm(root, { recursive: true, force: true })));
  }
}

async function exactCheckout(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw coded("EINVAL", "Template checkout path must be absolute");
  const checkout = await fs.realpath(input);
  const marker = await fs.lstat(path.join(checkout, ".git"));
  if (!marker.isDirectory() && !marker.isFile())
    throw coded("EINVAL", "Template checkout has no Git metadata");
  return checkout;
}

function encodePending(pending: PendingTemplateExchange): NonNullable<Marker["pending"]> {
  return {
    ...pending,
    baseline: pending.baseline.map(({ bytes, ...entry }) => ({
      ...entry,
      base64: bytes.toString("base64"),
    })),
  };
}

function decodePending(pending: NonNullable<Marker["pending"]>): PendingTemplateExchange {
  return {
    ...pending,
    baseline: pending.baseline.map(({ base64, ...entry }) => ({
      ...entry,
      bytes: Buffer.from(base64, "base64"),
    })),
  };
}

async function readMarker(file: string): Promise<Marker> {
  const marker = JSON.parse(await fs.readFile(file, "utf8")) as Marker;
  if (marker.version !== 1 || !/^[a-f0-9]{64}$/u.test(marker.intentDigest))
    throw coded("ECORRUPT", "Invalid template exchange marker");
  return marker;
}

async function writeMarker(file: string, marker: Marker): Promise<void> {
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw coded("EOWNERSHIP", "Exchange operation escaped its owned root");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

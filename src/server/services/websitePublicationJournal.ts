import fs from "node:fs";
import path from "node:path";
import {
  WEBSITE_PUBLICATION_PHASES,
  WebsitePublicationReceiptSchema,
  type WebsitePublicationIntentParams,
  type WebsitePublicationProgressParams,
  type WebsitePublicationReceiptResult,
} from "@vibestudio/service-schemas/credentials";
import {
  loadVersionedJsonFile,
  saveVersionedJsonFile,
  type VersionedJsonCodec,
} from "../hostCore/versionedJsonStore.js";

const WEBSITE_PUBLICATION_JOURNAL_SCHEMA_VERSION = 1 as const;

interface WebsitePublicationJournalFile {
  publications: WebsitePublicationReceiptResult[];
}

const WEBSITE_PUBLICATION_JOURNAL_CODEC: VersionedJsonCodec<WebsitePublicationJournalFile> = {
  schemaName: "Website publication journal",
  currentVersion: WEBSITE_PUBLICATION_JOURNAL_SCHEMA_VERSION,
  decodeCurrent(value) {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "schemaVersion" && key !== "publications") ||
      !Array.isArray(record["publications"]) ||
      !record["publications"].every(isReceipt) ||
      new Set(record["publications"].map((receipt) => receipt.operationId)).size !==
        record["publications"].length
    ) {
      throw new Error("website publication journal contains invalid data");
    }
    return { publications: record["publications"] };
  },
  encode: (value) => ({ publications: value.publications }),
};

/** Typed refusal: one operation id is permanently bound to its first reviewed intent. */
export class WebsitePublicationIntentConflictError extends Error {
  readonly code = "WEBSITE_PUBLICATION_INTENT_CONFLICT";
  constructor(
    readonly recorded: WebsitePublicationIntentParams,
    readonly requested: WebsitePublicationIntentParams
  ) {
    super(
      `Website publication ${requested.operationId} is bound to artifact ${recorded.artifactDigest} ` +
        `for ${recorded.provider} ${recorded.destination} (${recorded.environment}); ` +
        "a changed artifact, provider, destination, or environment needs a new operation id"
    );
    this.name = "WebsitePublicationIntentConflictError";
  }
}

export function sameWebsitePublicationIntent(
  left: WebsitePublicationIntentParams,
  right: WebsitePublicationIntentParams
): boolean {
  return (
    left.operationId === right.operationId &&
    left.artifactDigest === right.artifactDigest &&
    left.provider === right.provider &&
    left.destination === right.destination &&
    left.environment === right.environment
  );
}

/**
 * Host-owned journal of website publication operations.
 *
 * Each operation id is bound to the exact artifact digest, provider,
 * destination, and environment it was first reviewed for. The journal records
 * the last completed phase so a later call for the same intent resumes from it
 * (or returns the finished receipt) instead of relying on caller-held state.
 * With no `statePath` the journal lives in memory only.
 */
export class WebsitePublicationJournal {
  private readonly filePath: string | null;
  private loaded = false;
  private publications = new Map<string, WebsitePublicationReceiptResult>();

  constructor(opts: { filePath?: string } = {}) {
    this.filePath = opts.filePath ?? null;
  }

  get(operationId: string): WebsitePublicationReceiptResult | null {
    this.load();
    const receipt = this.publications.get(operationId);
    return receipt ? { ...receipt } : null;
  }

  /** Open a new operation, or return the receipt of the identical recorded one. */
  begin(intent: WebsitePublicationIntentParams): WebsitePublicationReceiptResult {
    this.load();
    const existing = this.publications.get(intent.operationId);
    if (existing) {
      assertSameIntent(existing, intent);
      return { ...existing };
    }
    const receipt: WebsitePublicationReceiptResult = {
      ...intentOf(intent),
      phase: "prepared",
      updatedAt: new Date().toISOString(),
    };
    this.store(receipt);
    return { ...receipt };
  }

  /** Advance an open operation to a later completed phase. */
  record(
    intent: WebsitePublicationIntentParams,
    progress: WebsitePublicationProgressParams
  ): WebsitePublicationReceiptResult {
    this.load();
    const existing = this.publications.get(intent.operationId);
    if (!existing) {
      throw new Error(`Website publication ${intent.operationId} has not been opened`);
    }
    assertSameIntent(existing, intent);
    if (phaseIndex(progress.phase) <= phaseIndex(existing.phase)) {
      throw new Error(
        `Website publication ${intent.operationId} already completed ${existing.phase}; ` +
          `it cannot record ${progress.phase}`
      );
    }
    const receipt: WebsitePublicationReceiptResult = {
      ...existing,
      phase: progress.phase,
      ...(progress.deploymentId !== undefined ? { deploymentId: progress.deploymentId } : {}),
      ...(progress.url !== undefined ? { url: progress.url } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.store(receipt);
    return { ...receipt };
  }

  private load(): void {
    if (this.loaded) return;
    if (this.filePath) {
      try {
        const decoded = loadVersionedJsonFile(this.filePath, WEBSITE_PUBLICATION_JOURNAL_CODEC);
        for (const receipt of decoded?.publications ?? []) {
          this.publications.set(receipt.operationId, receipt);
        }
      } catch (error) {
        throw new Error(
          `Website publication journal ${this.filePath} cannot be loaded without risking data loss: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    }
    this.loaded = true;
  }

  private store(receipt: WebsitePublicationReceiptResult): void {
    // A failed durable write must not appear committed to later calls in this activation.
    const next = new Map(this.publications);
    next.set(receipt.operationId, receipt);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      saveVersionedJsonFile(
        this.filePath,
        { publications: [...next.values()] },
        WEBSITE_PUBLICATION_JOURNAL_CODEC
      );
    }
    this.publications = next;
  }
}

export function isTerminalWebsitePublication(receipt: WebsitePublicationReceiptResult): boolean {
  return receipt.phase === "submitted";
}

function phaseIndex(phase: WebsitePublicationReceiptResult["phase"]): number {
  return WEBSITE_PUBLICATION_PHASES.indexOf(phase);
}

function intentOf(intent: WebsitePublicationIntentParams): WebsitePublicationIntentParams {
  return {
    operationId: intent.operationId,
    artifactDigest: intent.artifactDigest,
    provider: intent.provider,
    destination: intent.destination,
    environment: intent.environment,
  };
}

function assertSameIntent(
  recorded: WebsitePublicationReceiptResult,
  requested: WebsitePublicationIntentParams
): void {
  if (!sameWebsitePublicationIntent(recorded, requested)) {
    throw new WebsitePublicationIntentConflictError(intentOf(recorded), intentOf(requested));
  }
}

function isReceipt(value: unknown): value is WebsitePublicationReceiptResult {
  return WebsitePublicationReceiptSchema.safeParse(value).success;
}

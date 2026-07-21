import * as fs from "node:fs";
import * as path from "node:path";
import { stateLayout } from "./stateLayout.js";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";

export interface RuntimeImageRecord {
  id: string;
  source: string;
  unitName: string;
  stateHash: string;
  buildKey: string;
  executionDigest: string;
  authorityRequests: UnitAuthorityManifest["requests"];
  authorityDelegations: UnitAuthorityManifest["delegations"];
  effectiveVersion: string;
  generation: number;
  error?: RuntimeImageRecordError;
  scopeRef?: string;
  updatedAt: number;
}

export interface RuntimeImageRecordError {
  code: "rebind_failed";
  message: string;
  failedAt: number;
}

interface RuntimeImageFile {
  version: 3;
  records: RuntimeImageRecord[];
}

export class RuntimeImageStore {
  private readonly filePath: string;
  private readonly records = new Map<string, RuntimeImageRecord>();

  constructor(statePath: string) {
    this.filePath = stateLayout(statePath).runtimeImagesFile;
    this.load();
  }

  get(id: string): RuntimeImageRecord | null {
    return this.records.get(id) ?? null;
  }

  list(): RuntimeImageRecord[] {
    return [...this.records.values()];
  }

  upsert(
    input: Omit<RuntimeImageRecord, "generation" | "updatedAt" | "error">
  ): RuntimeImageRecord {
    const previous = this.records.get(input.id);
    const record: RuntimeImageRecord = {
      ...input,
      generation: (previous?.generation ?? 0) + 1,
      updatedAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.persist();
    return record;
  }

  markError(
    id: string,
    error: Omit<RuntimeImageRecordError, "failedAt">
  ): RuntimeImageRecord | null {
    const previous = this.records.get(id);
    if (!previous) return null;
    const record: RuntimeImageRecord = {
      ...previous,
      error: {
        ...error,
        failedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    this.records.set(id, record);
    this.persist();
    return record;
  }

  delete(id: string): void {
    if (!this.records.delete(id)) return;
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as RuntimeImageFile;
      if (parsed.version !== 3 || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        if (
          typeof record.id === "string" &&
          typeof record.source === "string" &&
          typeof record.unitName === "string" &&
          typeof record.stateHash === "string" &&
          typeof record.buildKey === "string" &&
          /^[0-9a-f]{64}$/.test(record.executionDigest) &&
          typeof record.effectiveVersion === "string" &&
          typeof record.generation === "number" &&
          typeof record.updatedAt === "number"
        ) {
          const authority = parseUnitAuthorityManifest(
            {
              requests: record.authorityRequests,
              delegations: record.authorityDelegations,
            },
            `runtime image ${record.id} authority`
          );
          const normalized: RuntimeImageRecord = {
            ...record,
            authorityRequests: authority.requests,
            authorityDelegations: authority.delegations,
          };
          if (
            record.error &&
            (record.error.code !== "rebind_failed" ||
              typeof record.error.message !== "string" ||
              typeof record.error.failedAt !== "number")
          ) {
            delete normalized.error;
          }
          this.records.set(record.id, normalized);
        }
      }
    } catch {
      this.records.clear();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: RuntimeImageFile = {
      version: 3,
      records: this.list().sort((a, b) => a.id.localeCompare(b.id)),
    };
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

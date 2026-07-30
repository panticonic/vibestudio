import * as fs from "node:fs";
import * as path from "node:path";
import { stateLayout } from "./stateLayout.js";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import {
  loadVersionedJsonFile,
  saveVersionedJsonFile,
  type VersionedJsonCodec,
} from "./hostCore/versionedJsonStore.js";
import {
  publishExecutionOwner,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";

export interface RuntimeImageRecord {
  id: string;
  source: string;
  unitName: string;
  /** Complete, independently verified executable identity. */
  artifact: ExecutionArtifactRefV1;
  /** Complete sealed authority envelope for this exact executable image. */
  authority: UnitAuthorityManifest;
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
  records: RuntimeImageRecord[];
}

const RUNTIME_IMAGE_RECORD_KEYS = [
  "id",
  "source",
  "unitName",
  "artifact",
  "authority",
  "generation",
  "error",
  "scopeRef",
  "updatedAt",
] as const;

function runtimeImageRecord(
  value: unknown,
  index: number,
  schemaLabel = "runtime-images v7"
): RuntimeImageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${schemaLabel} record ${index} is not an object`);
  }
  const record = value as Partial<RuntimeImageRecord>;
  const invalid = (field: string): never => {
    throw new Error(`${schemaLabel} record ${index} has invalid ${field}`);
  };
  const unknownKeys = Object.keys(record).filter(
    (key) => !(RUNTIME_IMAGE_RECORD_KEYS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) invalid(`field(s): ${unknownKeys.join(", ")}`);
  if (typeof record.id !== "string" || record.id.length === 0) invalid("id");
  if (typeof record.source !== "string" || record.source.length === 0) invalid("source");
  if (typeof record.unitName !== "string" || record.unitName.length === 0) invalid("unitName");
  const artifact = (() => {
    try {
      return verifyExecutionArtifactRef(record.artifact as ExecutionArtifactRefV1);
    } catch {
      return invalid("artifact");
    }
  })();
  if (!Number.isSafeInteger(record.generation) || Number(record.generation) < 1) {
    invalid("generation");
  }
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    invalid("updatedAt");
  }
  if (record.scopeRef !== undefined && typeof record.scopeRef !== "string") invalid("scopeRef");
  if (record.error !== undefined) {
    if (
      !record.error ||
      record.error.code !== "rebind_failed" ||
      typeof record.error.message !== "string" ||
      typeof record.error.failedAt !== "number" ||
      !Number.isFinite(record.error.failedAt)
    ) {
      invalid("error");
    }
  }
  const authority = parseUnitAuthorityManifest(
    record.authority,
    `runtime image ${record.id} authority`
  );
  return {
    ...(record as RuntimeImageRecord),
    artifact,
    authority,
  };
}

function decodeRuntimeImageFile(value: unknown): RuntimeImageFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime-images v7 is not an object");
  }
  const file = value as Record<string, unknown>;
  const unknownKeys = Object.keys(file).filter((key) => key !== "version" && key !== "records");
  if (unknownKeys.length > 0) {
    throw new Error(`runtime-images v7 has unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (file["version"] !== 7) {
    throw new Error(`runtime-images v7 has invalid version ${String(file["version"])}`);
  }
  if (!Array.isArray(file["records"])) {
    throw new Error("runtime-images v7 records must be an array");
  }
  const records = file["records"].map((record, index) => runtimeImageRecord(record, index));
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`runtime-images v7 contains duplicate id ${record.id}`);
    }
    ids.add(record.id);
  }
  return { records };
}

const RUNTIME_IMAGE_CODEC: VersionedJsonCodec<RuntimeImageFile> = {
  schemaName: "runtime-images",
  currentVersion: 7,
  versionKey: "version",
  decodeCurrent: decodeRuntimeImageFile,
  encode: (value) => ({
    records: [...value.records].sort((a, b) => a.id.localeCompare(b.id)),
  }),
};

export class RuntimeImageStore {
  private readonly filePath: string;
  private readonly records = new Map<string, RuntimeImageRecord>();

  constructor(
    statePath: string,
    private readonly publicationPort?: ExecutionPublicationPort
  ) {
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
      artifact: verifyExecutionArtifactRef(input.artifact),
      authority: parseUnitAuthorityManifest(input.authority, `runtime image ${input.id} authority`),
      generation: (previous?.generation ?? 0) + 1,
      updatedAt: Date.now(),
    };
    const changed =
      previous?.artifact.buildKey !== record.artifact.buildKey ||
      previous?.artifact.executionDigest !== record.artifact.executionDigest;
    publishExecutionOwner(
      changed ? this.publicationPort : undefined,
      {
        owner: "runtime-image",
        ownerId: record.id,
        artifacts: [
          {
            buildKey: record.artifact.buildKey,
            executionDigest: record.artifact.executionDigest,
          },
        ],
      },
      () => {
        this.records.set(record.id, record);
        this.persist();
      }
    );
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
    const parsed = loadVersionedJsonFile(this.filePath, RUNTIME_IMAGE_CODEC);
    if (!parsed) return;
    for (const record of parsed.records) {
      this.records.set(record.id, record);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    saveVersionedJsonFile(this.filePath, { records: this.list() }, RUNTIME_IMAGE_CODEC);
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { UnitInstallSourceOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";

/**
 * Where an admission came from, for inventory and audit
 * (docs/template-install-unit-approval-ux-plan.md §6.4).
 *
 * Admission means: this exact unit version was reviewed and accepted. It is not
 * authority — an admitted unit with no stored grant still prompts (U5). The
 * origin says which decision accepted it.
 */
export type UnitAdmissionOrigin =
  | "workspace-creation"
  | "template-install"
  | "publication"
  | "launch-gate"
  | "host-build"
  | "chrome";

export const UNIT_ADMISSION_ORIGINS: readonly UnitAdmissionOrigin[] = [
  "workspace-creation",
  "template-install",
  "publication",
  "launch-gate",
  "host-build",
  "chrome",
];

interface AdmittedUnitVersion {
  repoPath: string;
  effectiveVersion: string;
  authorityDigest: string;
  serviceBindingDigest: string;
  origin: UnitAdmissionOrigin;
  admittedAt: number;
  /**
   * Where this unit's bytes came from, as `registrable-host/owner`
   * (§7.6.3) — `github.com/acme`, or `vibestudio` for the host's own build.
   *
   * The `origin` above says which decision admitted a unit, which is a
   * different question and cannot answer this one: "the user accepted this at
   * the launch gate" says nothing about whose code it was. First encounter keys
   * on the source, so without this field it can never be anything but true.
   *
   * Absent on records written before the field existed. Those simply contribute
   * no source; an unknown source is not evidence the user has seen one.
   */
  sourceOriginKey?: string;
  /** The full origin URL, for support and audit. Null for the host build. */
  sourceUrl?: string | null;
  /**
   * The human ref that source was at — `v1.2.0`, never a commit.
   *
   * Kept because the URL alone cannot say what a person read on the card they
   * answered. `Originally installed from github.com/panticonic/news` names a
   * place; `Originally installed from News 1.2.0` names the thing they added.
   */
  sourceVersion?: string | null;
  /**
   * The template's self-given name at admission. A title, never identity.
   *
   * Recorded rather than looked up later for the same reason the URL is: once a
   * template is removed the lock that held its name is gone, and the only
   * honest way to keep saying where a part came from is to have written it down
   * while it was still true (§U2).
   */
  sourceSelfName?: string | null;
  sourceIsWorkspaceRoot?: boolean;
}

/** What the server derived about a unit's source, at the moment it was admitted. */
export type UnitSourceOrigin = UnitInstallSourceOrigin;

interface AdmittedUnitVersionFile {
  schemaVersion: 4;
  admissions: AdmittedUnitVersion[];
}

export interface UnitAdmissionIdentity {
  repoPath: string;
  effectiveVersion: string;
  authority: UnitAuthorityManifest;
  serviceBindingDigest?: string;
}

export interface UnitAdmissionRecord extends UnitAdmissionIdentity {
  origin: UnitAdmissionOrigin;
  admittedAt: number;
}

export interface UnitAdmissionTransaction {
  /** Admit through this transaction so rollback owns only these exact writes. */
  admitMany(
    identities: Iterable<UnitAdmissionIdentity>,
    origin: UnitAdmissionOrigin,
    now?: number,
    sourceOrigins?: ReadonlyMap<string, UnitSourceOrigin | null>
  ): void;
  /** Make the prepared admission permanent. */
  committed(): void;
  /** Undo this transaction's writes without disturbing later admissions. */
  failed(error: unknown): void;
}

/**
 * Durable exact-version admission decisions; never inferred from source or
 * generated docs.
 *
 * Admission binds unit source identity, effective version, and manifest digest
 * (U7). Any change to a unit's declared authority or its code identity produces
 * a different key and therefore requires a new admission.
 */
export class UnitAdmissionStore {
  private readonly filePath: string;
  private admissions = new Map<string, AdmittedUnitVersion>();
  private readonly resolveSourceOrigin: ((repoPath: string) => UnitSourceOrigin | null) | null;
  private readonly writeState: typeof writeFileAtomicSync;

  constructor(opts: {
    statePath: string;
    /**
     * Where a unit's bytes came from, derived by the server from workspace
     * state it reads itself.
     *
     * Asked here rather than passed in by each accepting surface: every caller
     * would otherwise have to remember, and one that forgot would silently
     * write a record that makes its source look unknown forever. A client
     * assertion is never accepted for this — the whole value of the signal is
     * that nothing being reviewed gets to state it.
     */
    resolveSourceOrigin?: (repoPath: string) => UnitSourceOrigin | null;
    /** Injectable only for exercising durable-write failure behavior. */
    writeFileAtomic?: typeof writeFileAtomicSync;
  }) {
    this.resolveSourceOrigin = opts.resolveSourceOrigin ?? null;
    this.writeState = opts.writeFileAtomic ?? writeFileAtomicSync;
    const layout = stateLayout(opts.statePath).authority;
    this.filePath = path.join(layout.root, "admitted-unit-versions.json");
    // Cutover, not migration: the all-or-nothing schema has no reader here, and
    // its file is removed rather than translated.
    try {
      fs.rmSync(layout.approvedUnitVersionsFile, { force: true });
    } catch {
      // A read-only state directory simply leaves the orphan in place.
    }
    this.load();
  }

  /**
   * No unit has ever been admitted here. True before the creation review has
   * been answered, and after a cutover discarded an older admission file — in
   * both cases the workspace owes the review, whatever any marker says.
   */
  isEmpty(): boolean {
    return this.admissions.size === 0;
  }

  has(identity: UnitAdmissionIdentity): boolean {
    return this.admissions.has(identityKey(identity));
  }

  originFor(identity: UnitAdmissionIdentity): UnitAdmissionOrigin | null {
    return this.admissions.get(identityKey(identity))?.origin ?? null;
  }

  /**
   * Which decision admitted this exact version, and where its bytes came from.
   *
   * Keyed by version rather than by full identity because the caller with this
   * question is Permissions (§7.7), which holds a grant. A grant's subject is
   * `code:<repoPath>@<effectiveVersion>` and carries no manifest digest, so it
   * can name the version but never the declaration — and the origin line only
   * ever needed the version.
   */
  provenanceForVersion(
    repoPath: string,
    effectiveVersion: string
  ): {
    origin: UnitAdmissionOrigin;
    sourceUrl: string | null;
    /** The template's self-given name, when one was recorded. A title, never identity. */
    sourceSelfName: string | null;
    /** The human ref that source was at. Never a commit or a digest. */
    sourceVersion: string | null;
  } | null {
    for (const record of this.admissions.values()) {
      if (record.repoPath !== repoPath || record.effectiveVersion !== effectiveVersion) continue;
      return {
        origin: record.origin,
        sourceUrl: record.sourceUrl ?? null,
        sourceSelfName: record.sourceSelfName ?? null,
        sourceVersion: record.sourceVersion ?? null,
      };
    }
    return null;
  }

  /**
   * Some admission exists for this exact version, whatever it declared.
   *
   * Weaker than `has`, and deliberately so: this answers "has this version ever
   * been reviewed", which is the question the creation review asks. Whether a
   * *changed* declaration needs a fresh decision is `has`'s job, since only it
   * compares the manifest digest.
   */
  hasVersion(repoPath: string, effectiveVersion: string): boolean {
    for (const record of this.admissions.values()) {
      if (record.repoPath === repoPath && record.effectiveVersion === effectiveVersion) return true;
    }
    return false;
  }

  /**
   * The version of this unit an incoming one replaces, if any.
   *
   * Admission is keyed by exact version, so a repo path accumulates a row per
   * version it was ever admitted at; the most recently admitted is the one the
   * workspace is actually running, and therefore the one whose clearance retires
   * and whose decision an unasked update carries forward (§7.3). Ties break on
   * the version itself so the answer is the same on every boot.
   */
  latestAdmittedVersion(repoPath: string): string | null {
    let latest: AdmittedUnitVersion | null = null;
    for (const record of this.admissions.values()) {
      if (record.repoPath !== repoPath) continue;
      if (
        !latest ||
        record.admittedAt > latest.admittedAt ||
        (record.admittedAt === latest.admittedAt &&
          record.effectiveVersion > latest.effectiveVersion)
      ) {
        latest = record;
      }
    }
    return latest?.effectiveVersion ?? null;
  }

  /**
   * The source recorded for a repository, latest admission first (§U2).
   *
   * The durable half of origin resolution. The live template lock answers where
   * a part comes from while a template still owns it; this answers afterwards,
   * from the record the server wrote itself at the moment of the decision. It is
   * never a claim by anything under review, so it carries the same weight as the
   * lock and simply outlives it.
   *
   * Keyed by repo path rather than by exact identity because the question it
   * answers is about the part, not about one of its versions: a part updated
   * three times still came from the same place, and the most recent admission is
   * the one whose attribution is current.
   */
  recordedSourceFor(repoPath: string): {
    url: string | null;
    version: string | null;
    selfName: string | null;
    isWorkspaceRoot: boolean;
  } | null {
    let latest: AdmittedUnitVersion | null = null;
    for (const record of this.admissions.values()) {
      if (record.repoPath !== repoPath) continue;
      if (!record.sourceOriginKey) continue;
      if (
        !latest ||
        record.admittedAt > latest.admittedAt ||
        (record.admittedAt === latest.admittedAt &&
          record.effectiveVersion > latest.effectiveVersion)
      ) {
        latest = record;
      }
    }
    if (!latest) return null;
    return {
      url: latest.sourceUrl ?? null,
      version: latest.sourceVersion ?? null,
      selfName: latest.sourceSelfName ?? null,
      isWorkspaceRoot: latest.sourceIsWorkspaceRoot === true,
    };
  }

  /** Every admitted repo path. Inventory, not identity. */
  admittedRepoPaths(): string[] {
    return [...new Set([...this.admissions.values()].map((record) => record.repoPath))].sort();
  }

  /**
   * Every source the user has already run code from, for first encounter.
   *
   * This is the key space `templateOrigin` compares against — `github.com/acme`,
   * never a repo path. Records with no recorded source contribute nothing, which
   * reads as "unfamiliar" and is the safe direction: at worst the user is told a
   * true thing about a source they have in fact seen once before.
   */
  admittedOriginKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const record of this.admissions.values()) {
      if (record.sourceOriginKey) keys.add(record.sourceOriginKey);
    }
    return keys;
  }

  admit(identity: UnitAdmissionIdentity, origin: UnitAdmissionOrigin, now = Date.now()): void {
    this.admitMany([identity], origin, now);
  }

  /** One transaction: an accepted operation admits every unit it lands, or none. */
  admitMany(
    identities: Iterable<UnitAdmissionIdentity>,
    origin: UnitAdmissionOrigin,
    now = Date.now(),
    sourceOrigins?: ReadonlyMap<string, UnitSourceOrigin | null>
  ): void {
    const nextAdmissions = new Map(this.admissions);
    let changed = false;
    for (const identity of identities) {
      const source = sourceOrigins?.has(identity.repoPath)
        ? (sourceOrigins.get(identity.repoPath) ?? null)
        : (this.resolveSourceOrigin?.(identity.repoPath) ?? null);
      const record = {
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        authorityDigest: authorityDigest(identity.authority),
        serviceBindingDigest: identity.serviceBindingDigest ?? sha256Canonical([]),
        origin,
        admittedAt: now,
        ...(source
          ? {
              sourceOriginKey: source.originKey,
              sourceUrl: source.url,
              // Written now or never. A removed template takes its lock entry —
              // and with it its name and its ref — out of the workspace, so the
              // only way `Originally installed from News 1.2.0` can still be
              // said afterwards is that it was recorded while it was true.
              ...(source.version ? { sourceVersion: source.version } : {}),
              ...(source.selfName ? { sourceSelfName: source.selfName } : {}),
              ...(source.isWorkspaceRoot ? { sourceIsWorkspaceRoot: true } : {}),
            }
          : {}),
      } satisfies AdmittedUnitVersion;
      nextAdmissions.set(identityKey(record), record);
      changed = true;
    }
    if (!changed) return;
    // Write the candidate state before changing the live map. If the atomic
    // write fails, this instance must continue answering from the last durable
    // state rather than from an unpersisted admission.
    this.save(nextAdmissions);
    this.admissions = nextAdmissions;
  }

  /** Retire the admissions of units an operation removed. */
  retire(identities: Iterable<UnitAdmissionIdentity>): void {
    const nextAdmissions = new Map(this.admissions);
    let changed = false;
    for (const identity of identities) {
      if (nextAdmissions.delete(identityKey(identity))) changed = true;
    }
    if (!changed) return;
    this.save(nextAdmissions);
    this.admissions = nextAdmissions;
  }

  /** Begin a reversible admission change for a multi-store publication. */
  beginTransaction(): UnitAdmissionTransaction {
    const writes = new Map<
      string,
      { before: AdmittedUnitVersion | undefined; applied: AdmittedUnitVersion }
    >();
    let settled = false;
    return {
      admitMany: (identities, origin, now, sourceOrigins) => {
        if (settled) throw new Error("Admission transaction is already settled");
        const accepted = [...identities];
        const before = new Map(
          accepted.map((identity) => {
            const key = identityKey(identity);
            return [key, this.admissions.get(key)] as const;
          })
        );
        this.admitMany(accepted, origin, now, sourceOrigins);
        for (const identity of accepted) {
          const key = identityKey(identity);
          const applied = this.admissions.get(key);
          if (!applied) throw new Error(`Prepared admission disappeared for ${identity.repoPath}`);
          writes.set(key, {
            // `undefined` is meaningful: the transaction created this key.
            // Preserve it across repeated writes by the same transaction.
            before: writes.has(key) ? writes.get(key)!.before : before.get(key),
            applied,
          });
        }
      },
      committed: () => {
        settled = true;
      },
      failed: () => {
        if (settled) return;
        const restored = new Map(this.admissions);
        let changed = false;
        for (const [key, write] of writes) {
          // A later decision for the same identity owns its newer record. The
          // object reference is the in-process write token: unrelated writes
          // retain it, while another admission of this key replaces it.
          if (restored.get(key) !== write.applied) continue;
          if (write.before) restored.set(key, write.before);
          else restored.delete(key);
          changed = true;
        }
        if (changed) {
          // Persist first so a failed rollback cannot make memory claim that
          // the restored state is durable when it is not.
          this.save(restored);
          this.admissions = restored;
        }
        settled = true;
      },
    };
  }

  private load(): void {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(source) as Partial<AdmittedUnitVersionFile>;
    if (parsed.schemaVersion !== 4 || !Array.isArray(parsed.admissions)) {
      // Cutover, not migration. An older file records admissions that were
      // taken when admission still implied blanket authority, so re-reading it
      // would leave units admitted and ungranted — running, but asking for
      // things they were already allowed. Discarding it re-offers the creation
      // review, which is the decision that mints clearance honestly.
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    for (const admission of parsed.admissions) {
      if (!isAdmission(admission)) {
        throw new Error(`Invalid admitted-unit-version record in ${this.filePath}`);
      }
      this.admissions.set(identityKey(admission), admission);
    }
  }

  private save(admissions = this.admissions): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: AdmittedUnitVersionFile = {
      schemaVersion: 4,
      admissions: [...admissions.values()].sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right))
      ),
    };
    this.writeState(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function authorityDigest(authority: UnitAuthorityManifest): string {
  // The complete reviewed contract is load-bearing: admitting a unit admits the
  // exact requests and provided services it declared, so a changed declaration
  // is a different unit.
  return sha256Canonical({
    requests: authority.requests,
    serviceRequests: authority.serviceRequests ?? [],
    provides: authority.provides,
  });
}

function identityKey(
  identity:
    | Pick<
        AdmittedUnitVersion,
        "repoPath" | "effectiveVersion" | "authorityDigest" | "serviceBindingDigest"
      >
    | UnitAdmissionIdentity
): string {
  const digest =
    "authorityDigest" in identity ? identity.authorityDigest : authorityDigest(identity.authority);
  const serviceBindingDigest = identity.serviceBindingDigest ?? sha256Canonical([]);
  return `${identity.repoPath}\0${identity.effectiveVersion}\0${digest}\0${serviceBindingDigest}`;
}

const ADMISSION_KEYS = new Set([
  "admittedAt",
  "authorityDigest",
  "serviceBindingDigest",
  "effectiveVersion",
  "origin",
  "repoPath",
  // Added after the first records were written. A record without them is read,
  // not rejected: losing every admission would re-offer the creation review for
  // a field that only makes the gate's copy better.
  "sourceOriginKey",
  "sourceUrl",
  "sourceVersion",
  "sourceSelfName",
  "sourceIsWorkspaceRoot",
]);

function isAdmission(value: unknown): value is AdmittedUnitVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => ADMISSION_KEYS.has(key)) &&
    (record["sourceOriginKey"] === undefined || typeof record["sourceOriginKey"] === "string") &&
    (record["sourceUrl"] === undefined ||
      record["sourceUrl"] === null ||
      typeof record["sourceUrl"] === "string") &&
    (record["sourceVersion"] === undefined ||
      record["sourceVersion"] === null ||
      typeof record["sourceVersion"] === "string") &&
    (record["sourceSelfName"] === undefined ||
      record["sourceSelfName"] === null ||
      typeof record["sourceSelfName"] === "string") &&
    (record["sourceIsWorkspaceRoot"] === undefined ||
      typeof record["sourceIsWorkspaceRoot"] === "boolean") &&
    typeof record["repoPath"] === "string" &&
    record["repoPath"].length > 0 &&
    typeof record["effectiveVersion"] === "string" &&
    record["effectiveVersion"].length > 0 &&
    typeof record["authorityDigest"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["authorityDigest"]) &&
    typeof record["serviceBindingDigest"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["serviceBindingDigest"]) &&
    UNIT_ADMISSION_ORIGINS.includes(record["origin"] as UnitAdmissionOrigin) &&
    typeof record["admittedAt"] === "number" &&
    Number.isFinite(record["admittedAt"])
  );
}

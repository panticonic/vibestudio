import {
  EVAL_OPERATION_JOURNAL_MAX_ENTRIES,
  EVAL_OPERATION_JOURNAL_PREVIEW_CHARS,
  type EvalOperationJournal,
} from "@vibestudio/service-schemas/eval";
import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";

/** Native effect evidence belongs to one execution, independently of its return value. */
export class ExecutionJournal {
  readonly entries: Record<string, unknown>[] = [];
  truncated = false;
  private characters = 0;
  private closed = false;

  append(entry: Record<string, unknown>): void {
    if (this.closed) return;
    const encoded = JSON.stringify(entry);
    if (this.entries.length >= EVAL_OPERATION_JOURNAL_MAX_ENTRIES ||
        this.characters + encoded.length > EVAL_OPERATION_JOURNAL_PREVIEW_CHARS) {
      this.truncated = true;
      return;
    }
    // Guest code can later mutate a returned object; it cannot mutate this copy.
    this.entries.push(JSON.parse(encoded) as Record<string, unknown>);
    this.characters += encoded.length;
  }

  recordBuildProfile(profile: BuildPerformanceProfileWire): void {
    this.append({ type: "build.profile", receipt: {
      version: profile.version,
      source: profile.source,
      ref: profile.ref,
      startedAt: profile.startedAt,
      firstRun: { ...profile.firstRun },
      verifiedCacheRun: profile.verifiedCacheRun ? { ...profile.verifiedCacheRun } : null,
      report: {
        repoPath: profile.report.repoPath,
        kind: profile.report.kind,
        status: profile.report.status,
        stateHash: profile.report.stateHash,
        diagnostics: profile.report.diagnostics.map(({ severity }) => ({ severity })),
        builds: profile.report.builds.map(({ target, buildKey }) => ({ target, buildKey })),
      },
      targets: profile.targets.map(({ target, buildKey, artifactCount, artifactBytes, executableModuleCount, executableSourceBytes, bundleReport }) => ({
        target, buildKey, artifactCount, artifactBytes, executableModuleCount, executableSourceBytes,
        ...(bundleReport ? { bundleReport: { initial: { bytes: bundleReport.initial.bytes } } } : {}),
      })),
    } });
  }

  close(): EvalOperationJournal {
    this.closed = true;
    return { protocol: "workspace-operations.v1", entries: this.entries, truncated: this.truncated };
  }
}

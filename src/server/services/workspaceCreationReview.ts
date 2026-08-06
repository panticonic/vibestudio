import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";

/**
 * The one publication that is not gated, and the review that answers for it.
 *
 * `mainAdvanceApproval`'s `workspace-initialization` branch installs the first
 * snapshot without prompting — correctly, because at the moment it runs there is
 * no workspace yet and nobody to ask. It therefore records no admission, and the
 * units it landed have none.
 *
 * That gap is closed by the creation review (§7.1): the workspace opens on the
 * collection surface, headed by the template being adopted, and accepting it
 * records admission for every unit the snapshot installed. This marker is what
 * carries the obligation from the ungated publication to the surface — it is
 * written when creation publishes, and cleared only when the review resolves, so
 * a restart before the user answers does not lose the question.
 *
 * It is deliberately NOT a boot-time sweep. Boot consults this marker; when it
 * is absent — every boot after the first — nothing is derived and no card can
 * appear (§12 Phase A, acceptance criterion 1).
 */
interface CreationReviewFile {
  schemaVersion: 1;
  pending: boolean;
  /**
   * Recorded when creation ran, for the review's heading and its origin line.
   *
   * The URL and the human ref are the identity a person reads. The commit is
   * deliberately absent: no commit id or content digest appears on any review
   * surface, at any disclosure level (§7.6.3).
   */
  rootTemplate?: { url: string | null; ref: string | null; version: string | null };
  markedAt: number;
}

export class WorkspaceCreationReviewStore {
  private readonly filePath: string;
  private state: CreationReviewFile | null = null;

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(
      stateLayout(opts.statePath).authority.root,
      "workspace-creation-review.json"
    );
    this.load();
  }

  /** True while the units the creation publication landed still need a decision. */
  isPending(): boolean {
    return this.state?.pending === true;
  }

  rootTemplate(): CreationReviewFile["rootTemplate"] {
    return this.state?.rootTemplate;
  }

  /** Called by the creation publication itself, before anything can run. */
  markPending(rootTemplate?: CreationReviewFile["rootTemplate"], now = Date.now()): void {
    if (this.state?.pending) return;
    this.state = {
      schemaVersion: 1,
      pending: true,
      ...(rootTemplate ? { rootTemplate } : {}),
      markedAt: now,
    };
    this.save();
  }

  /** Called once the review resolves and its admissions have committed. */
  resolve(now = Date.now()): void {
    if (!this.state?.pending) return;
    this.state = { ...this.state, pending: false, markedAt: now };
    this.save();
  }

  private load(): void {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(source) as Partial<CreationReviewFile>;
    if (parsed.schemaVersion !== 1 || typeof parsed.pending !== "boolean") {
      throw new Error(`Unknown workspace-creation-review schema in ${this.filePath}`);
    }
    this.state = parsed as CreationReviewFile;
  }

  private save(): void {
    if (!this.state) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }
}

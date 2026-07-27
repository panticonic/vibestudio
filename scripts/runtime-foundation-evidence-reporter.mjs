import fs from "node:fs";
import path from "node:path";

export default class RuntimeFoundationEvidenceReporter {
  constructor(options = {}) {
    this.project = options.project;
    this.entries = [];
    this.root = path.resolve(options.root ?? process.cwd());
  }

  onTestCaseResult(testCase) {
    const match = /^ledger:([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)$/.exec(testCase.name);
    if (!match) return;
    this.entries.push({
      id: match[1],
      file: path.relative(this.root, testCase.module.moduleId).replaceAll(path.sep, "/"),
      project: this.project,
      status: testCase.result().state,
    });
  }

  onTestRunEnd() {
    const directory = path.join(this.root, ".cache", "runtime-foundation-evidence");
    const sessionPath = path.join(directory, "session.json");
    if (!fs.existsSync(sessionPath)) return;
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (!session.expectedProjects.includes(this.project)) return;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${this.project}.json`),
      `${JSON.stringify(
        { version: 1, sessionId: session.id, project: this.project, entries: this.entries },
        null,
        2
      )}\n`
    );
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect, afterEach } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { problemReportsMethods } from "@vibestudio/service-schemas/problemReports";
import { ProblemReportingStore } from "./store";
import { createProblemReportsService } from "../services/problemReportsService";
import { reportFixture } from "./testFixture";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
);
function fixture(ownedServer?: Parameters<typeof createProblemReportsService>[0]["ownedServer"]) {
  const dir = mkdtempSync(join(tmpdir(), "report-service-"));
  const store = new ProblemReportingStore(dir);
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close()
  );
  const service = createProblemReportsService({
    store,
    ownedServer,
    workspaceId: "ws",
    redact: (text) => text.replaceAll("registered-sensitive-token", "[secret removed]"),
    importPrepared: async () =>
      reportFixture({
        narrative: [
          {
            id: randomUUID(),
            author: "agent",
            authorLabel: "Investigator",
            section: "findings",
            claims: "observed",
            markdown: "A substantial evidence-linked narrative. ".repeat(1500),
            evidenceIds: [],
          },
        ],
      }),
  });
  const client = (kind: "shell" | "do", userId = "alice") =>
    createTypedServiceClient("problemReports", problemReportsMethods, (_service, method, args) =>
      service.handler(
        {
          caller: createVerifiedCaller(kind + "-1", kind, null, null, { userId, handle: userId }),
        } as ServiceContext,
        method,
        args
      )
    );
  return { store, human: client("shell"), agent: client("do"), other: client("do", "bob") };
}
it("allows agent preparation while only a verified human can consent or send, and isolates owners", async () => {
  const f = fixture();
  expect((await f.human.consent()).state).toBe("undecided");
  await expect(f.agent.decide(0, "on")).rejects.toThrow();
  await f.human.decide(0, "off");
  const draft = await f.agent.create(reportFixture().problem);
  await expect(f.other.get(draft.id)).rejects.toThrow();
  const frozen = await f.agent.prepare(draft.id, draft.revision);
  await expect(f.agent.send(draft.id, draft.revision, frozen.digest)).rejects.toThrow();
  await f.human.send(draft.id, draft.revision, frozen.digest);
  expect(f.store.submission("alice", "ws", draft.value.submissionId)["state"]).toBe("queued");
});
it("makes sanitization reviewable and rejects an outdated preview", async () => {
  const f = fixture();
  const draft = await f.human.create({
    ...reportFixture().problem,
    symptom: "registered-sensitive-token at https://example.com/?password=secret",
  });
  await expect(f.human.prepare(draft.id, 1)).rejects.toThrow("Sensitive text");
  const revised = await f.human.get(draft.id);
  expect(revised.value.problem.symptom).not.toContain("registered-sensitive-token");
  const preview = await f.human.prepare(draft.id, revised.revision);
  await expect(f.human.send(draft.id, 1, preview.digest)).rejects.toThrow();
  expect(preview.bytes).not.toContain("password=secret");
});
it("imports a selected frozen server snapshot once, preserves agent narrative, and never enrolls or sends", async () => {
  const f = fixture();
  const reference = { reportId: randomUUID(), revision: 3, digest: "1".repeat(64) };
  const first = await f.human.importPrepared(reference);
  const second = await f.human.importPrepared(reference);
  expect(second.id).toBe(first.id);
  expect(first.value.narrative[0]?.markdown.length).toBeGreaterThan(50000);
  expect((await f.human.consent()).state).toBe("undecided");
  expect((await f.human.history())[0]?.["state"]).toBeNull();
});

it("edits only draft content while the host assigns identity and revision and preserves frozen submissions", async () => {
  const f = fixture();
  const draft = await f.agent.create(reportFixture().problem);
  const preview = await f.agent.prepare(draft.id, draft.revision);
  const { problem, references, narrative, evidence, attachments } = draft.value;
  const edit = {
    problem,
    references,
    evidence,
    attachments,
    narrative: [
      ...narrative,
      {
        id: randomUUID(),
        section: "findings" as const,
        author: "agent" as const,
        authorLabel: "Agent",
        claims: "observed" as const,
        markdown: "The supplied wrong result is preserved; reproduction remains unverified.",
        evidenceIds: [],
      },
    ],
  };
  const updated = await f.agent.update(draft.id, draft.revision, edit);
  const current = await f.agent.get(draft.id);
  expect(updated.revision).toBe(2);
  expect(current.value.reportRevision).toBe(2);
  expect(current.value.submissionId).not.toBe(preview.submissionId);
  expect(current.value.consent).toEqual(draft.value.consent);
  expect(current.value.narrative).toHaveLength(1);
  await expect(f.agent.update(draft.id, draft.revision, edit)).rejects.toThrow("changed");
  await expect(f.human.send(draft.id, draft.revision, preview.digest)).rejects.toThrow();
});

it("exposes an owned server's independent choice only through trusted human controls", async () => {
  const remote = fixture();
  const local = fixture({
    consent: () => remote.human.consent(),
    decide: (revision, state) => remote.human.decide(revision, state),
  });
  expect((await local.human.serverConsent())?.state).toBe("undecided");
  await local.human.decide(0, "off");
  expect((await remote.human.consent()).state).toBe("undecided");
  await expect(local.agent.decideServer(0, "on")).rejects.toThrow();
  await local.human.decideServer(0, "on");
  expect((await local.human.consent()).state).toBe("off");
  expect((await remote.human.consent()).state).toBe("on");
  await expect(local.human.decideServer(0, "off")).rejects.toThrow("Consent changed");
  const external = fixture();
  expect(await external.human.serverConsent()).toBeNull();
  await expect(external.human.decideServer(0, "on")).rejects.toThrow("does not own");
});

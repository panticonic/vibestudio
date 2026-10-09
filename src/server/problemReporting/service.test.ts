import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect, afterEach, vi } from "vitest";
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
function fixture(
  connectedServer?: Parameters<typeof createProblemReportsService>[0]["connectedServer"],
  approveSend?: Parameters<typeof createProblemReportsService>[0]["approveSend"],
  forwardDraft?: Parameters<typeof createProblemReportsService>[0]["forwardDraft"]
) {
  const dir = mkdtempSync(join(tmpdir(), "report-service-"));
  const store = new ProblemReportingStore(dir);
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close()
  );
  const service = createProblemReportsService({
    store,
    connectedServer,
    approveSend,
    forwardDraft,
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
  const preview = await f.human.prepare(draft.id, 1);
  expect(preview.revision).toBe(2);
  const revised = await f.human.get(draft.id);
  expect(revised.revision).toBe(preview.revision);
  expect(revised.value.problem.symptom).not.toContain("registered-sensitive-token");
  expect(revised.value.submissionId).toBe(preview.submissionId);
  expect(preview.bytes).not.toContain("password=secret");
  expect(preview.bytes).not.toContain("registered-sensitive-token");
  await expect(f.human.send(draft.id, 1, preview.digest)).rejects.toThrow();
  await f.human.send(draft.id, preview.revision, preview.digest);
  expect(f.store.submission("alice", "ws", preview.submissionId)["state"]).toBe("queued");
});
it("appends narrative with host-assigned IDs and caller-derived authorship, and patches by section ID", async () => {
  const f = fixture();
  const draft = await f.agent.create(reportFixture().problem);
  const section = {
    section: "findings" as const,
    authorLabel: "Agent",
    claims: "inferred" as const,
    markdown: "The ordering step likely compared case-folded keys.",
    evidenceIds: [],
  };
  const appended = await f.agent.appendNarrative(draft.id, draft.revision, [
    section,
    { ...section, section: "questions", claims: "unverified", markdown: "Is it reproducible?" },
  ]);
  expect(appended.revision).toBe(2);
  expect(appended.sectionIds).toHaveLength(2);
  const human = await f.human.appendNarrative(draft.id, appended.revision, [
    { ...section, section: "symptom", claims: "observed", markdown: "It sorted wrongly." },
  ]);
  const current = await f.agent.get(draft.id);
  expect(current.value.narrative.map((n) => [n.id, n.author])).toEqual([
    [appended.sectionIds[0], "agent"],
    [appended.sectionIds[1], "agent"],
    [human.sectionIds[0], "user"],
  ]);
  await expect(f.agent.appendNarrative(draft.id, appended.revision, [section])).rejects.toThrow(
    "changed"
  );
  const patched = await f.agent.patchNarrative(draft.id, human.revision, appended.sectionIds[0]!, {
    claims: "observed",
    markdown: "Verified: keys were case-folded.",
  });
  const after = await f.agent.get(draft.id);
  expect(after.value.narrative[0]).toMatchObject({
    id: appended.sectionIds[0],
    author: "agent",
    section: "findings",
    claims: "observed",
    markdown: "Verified: keys were case-folded.",
  });
  await expect(
    f.agent.patchNarrative(draft.id, patched.revision, human.sectionIds[0]!, { markdown: "x" })
  ).rejects.toThrow("only be edited by the user");
  await expect(
    f.agent.patchNarrative(draft.id, patched.revision, randomUUID(), { markdown: "x" })
  ).rejects.toThrow("unavailable");
  await f.human.patchNarrative(draft.id, patched.revision, human.sectionIds[0]!, {
    markdown: "It sorted gamma before beta.",
  });
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
    references,
    evidence,
    attachments,
    narrative,
    problem: { ...problem, symptom: "A corrected symptom" },
  };
  const updated = await f.agent.update(draft.id, draft.revision, edit);
  const current = await f.agent.get(draft.id);
  expect(updated.revision).toBe(2);
  expect(current.value.reportRevision).toBe(2);
  expect(current.value.submissionId).not.toBe(preview.submissionId);
  expect(current.value.consent).toEqual(draft.value.consent);
  expect(current.value.narrative).toEqual(narrative);
  await expect(f.agent.update(draft.id, draft.revision, edit)).rejects.toThrow("changed");
  await expect(f.human.send(draft.id, draft.revision, preview.digest)).rejects.toThrow();
});

it("exposes the connected server's independent per-user choice only through trusted human controls", async () => {
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
  expect(remote.store.consent("bob").state).toBe("undecided");
  const otherWorkspace = createProblemReportsService({
    store: remote.store,
    workspaceId: "another-workspace",
    redact: (text) => text,
  });
  expect(
    await otherWorkspace.handler!(
      {
        caller: createVerifiedCaller("shell-other-workspace", "shell", null, null, {
          userId: "alice",
          handle: "alice",
        }),
      },
      "consent",
      []
    )
  ).toMatchObject({ state: "on", revision: 1 });
  await expect(local.human.decideServer(0, "off")).rejects.toThrow("Consent changed");
  const withoutConnection = fixture();
  expect(await withoutConnection.human.serverConsent()).toBeNull();
  await expect(withoutConnection.human.decideServer(0, "on")).rejects.toThrow(
    "No connected server"
  );
});

it("submits an agent-prepared report only after targeted approval, even with automatic reporting off", async () => {
  const approve = vi.fn(async () => true);
  const f = fixture(undefined, approve);
  await f.human.decide(0, "off");
  const draft = await f.agent.create(reportFixture().problem);
  const preview = await f.agent.prepare(draft.id, draft.revision);
  await f.agent.send(draft.id, draft.revision, preview.digest);
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      caller: expect.objectContaining({ subject: expect.objectContaining({ userId: "alice" }) }),
    }),
    draft.value,
    preview.digest
  );
  expect((await f.human.consent()).state).toBe("off");
  expect(f.store.submission("alice", "ws", preview.submissionId)["state"]).toBe("queued");
});
it("keeps a denied agent report unsent and does not request approval for forged or another owner's previews", async () => {
  const approve = vi.fn(async () => false);
  const f = fixture(undefined, approve);
  const draft = await f.agent.create(reportFixture().problem);
  const preview = await f.agent.prepare(draft.id, draft.revision);
  await expect(f.other.send(draft.id, draft.revision, preview.digest)).rejects.toThrow();
  await expect(f.agent.send(draft.id, draft.revision, "0".repeat(64))).rejects.toThrow();
  expect(approve).not.toHaveBeenCalled();
  await expect(f.agent.send(draft.id, draft.revision, preview.digest)).rejects.toThrow(
    "not approved"
  );
  expect(f.store.submission("alice", "ws", preview.submissionId)["state"]).toBe("prepared");
});
it("does not upload a report edited while its submission approval is pending", async () => {
  let accept!: (value: boolean) => void;
  const f = fixture(
    undefined,
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      })
  );
  const draft = await f.agent.create(reportFixture().problem);
  const preview = await f.agent.prepare(draft.id, draft.revision);
  const pending = f.agent.send(draft.id, draft.revision, preview.digest);
  await f.agent.update(draft.id, draft.revision, {
    problem: { ...draft.value.problem, symptom: "A newer user correction" },
    references: [],
    narrative: [],
    evidence: [],
    attachments: [],
  });
  accept(true);
  await expect(pending).rejects.toThrow("Report changed");
  expect(f.store.submission("alice", "ws", preview.submissionId)["state"]).not.toBe("queued");
});

it("preserves substantial narrative in the agent-side handoff without a launch-prompt payload", async () => {
  const destination = { reportId: randomUUID(), revision: 2 };
  const forward = vi.fn(async () => destination);
  const f = fixture(undefined, undefined, forward);
  const draft = await f.human.importPrepared({
    reportId: randomUUID(),
    revision: 1,
    digest: "a".repeat(64),
  });
  expect(JSON.stringify(draft.value.narrative).length).toBeGreaterThan(4000);
  expect(await f.human.forConversation(draft.id, draft.revision)).toEqual(destination);
  expect(forward).toHaveBeenCalledWith(draft.value);
  await expect(f.other.forConversation(draft.id, draft.revision)).rejects.toThrow();
  await expect(f.human.forConversation(draft.id, draft.revision + 1)).rejects.toThrow();
  expect(forward).toHaveBeenCalledTimes(1);
});
it("leaves a server draft in place when the reporting conversation already runs on that server", async () => {
  const f = fixture();
  const draft = await f.agent.create(reportFixture().problem);
  expect(await f.agent.forConversation(draft.id, draft.revision)).toEqual({
    reportId: draft.id,
    revision: draft.revision,
  });
});
it("does not upload a cancelled report after its pending approval is accepted", async () => {
  let accept!: (value: boolean) => void;
  const f = fixture(
    undefined,
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      })
  );
  const draft = await f.agent.create(reportFixture().problem);
  const preview = await f.agent.prepare(draft.id, draft.revision);
  const pending = f.agent.send(draft.id, draft.revision, preview.digest);
  await f.agent.cancel(draft.id);
  accept(true);
  await expect(pending).rejects.toThrow();
  expect(f.store.submission("alice", "ws", preview.submissionId)["state"]).not.toBe("queued");
});

it("rejects full-replacement narrative forgery, deletion, and edits without changing the draft", async () => {
  const f = fixture();
  const draft = await f.human.create(reportFixture().problem);
  const appended = await f.human.appendNarrative(draft.id, draft.revision, [
    {
      section: "symptom",
      authorLabel: "User",
      claims: "observed",
      markdown: "The user's words",
      evidenceIds: [],
    },
  ]);
  const current = await f.agent.get(draft.id);
  const { problem, references, narrative, evidence, attachments } = current.value;
  for (const replacement of [
    [],
    [{ ...narrative[0]!, author: "agent" as const }],
    [{ ...narrative[0]!, markdown: "Forged correction" }],
    [...narrative, { ...narrative[0]!, id: randomUUID() }],
  ]) {
    await expect(
      f.agent.update(draft.id, appended.revision, {
        problem,
        references,
        narrative: replacement,
        evidence,
        attachments,
      })
    ).rejects.toThrow("Edit narrative through");
  }
  expect((await f.agent.get(draft.id)).revision).toBe(appended.revision);
  expect((await f.agent.get(draft.id)).value.narrative).toEqual(narrative);
});

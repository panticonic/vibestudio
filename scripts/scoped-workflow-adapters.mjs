// Explicit adapters reuse each template's independent verifier. The world and
// audit stay in this caller-owned module. Only bindings enter the Natlang task.
const simple = {
  automation: ["skills/automation-workflow-fixtures/verify.ts", "verifyAutomationWorld"],
  conversation: [
    "skills/conversation-evidence-review-fixtures/verify.ts",
    "verifyConversationEvidence",
  ],
  deviceAndTerminal: [
    "skills/device-and-terminal-review-fixtures/verify.ts",
    "verifyDeviceAndTerminalWorld",
  ],
  examples: ["skills/examples-review-fixtures/oracle.ts", "verifyExampleWorld"],
  gmailReview: ["skills/gmail-workflow-review-fixtures/verify.ts", "verifyGmailWorkflowWorld"],
  mediaImport: ["skills/media-and-import-review-fixtures/verify.ts", "verifyMediaImportWorld"],
  news: ["skills/news-workflow-fixtures/verify.ts", "verifyNewsWorld"],
  personalFacility: [
    "skills/personal-facility-review-fixtures/verify.ts",
    "verifyPersonalFacilityWorld",
  ],
  problems: ["skills/problem-review-fixtures/verify.ts", "verifyProblemWorld"],
  provenance: ["skills/provenance-review-fixtures/verify.ts", "verifyProvenanceWorld"],
  research: ["skills/research-intake-fixtures/verify.ts", "verifyResearchIntakeWorld"],
  runtimeEvidence: ["skills/runtime-evidence-review-fixtures/verify.ts", "verifyRuntimeEvidence"],
  sessionTest: [
    "skills/session-test-review-fixtures/oracle.ts",
    "verifySessionTestReview",
    (world) => world.expected,
  ],
  spectrolite: ["skills/spectrolite-review-fixtures/verify.ts", "verifySpectroliteWorld"],
  templates: ["skills/template-lifecycle-fixtures/verify.ts", "verifyTemplateWorld"],
  testReview: ["skills/system-test-review-fixtures/verify.ts", "verifySystemTestReview"],
  unitDesign: [
    "skills/workspace-unit-design-fixtures/oracle.ts",
    "verifyWorkspaceUnitReview",
    (world) => world.expected,
  ],
};

const bound = {
  async visualize(world, load) {
    const [{ verifyPresentation }, { renderComponent }] = await Promise.all([
      load("skills/visualization-fixtures/verify.ts"),
      load("skills/visualize/preparePresentation/prepareSection/render.ts"),
    ]);
    return {
      bindings: {},
      verify: (value) => verifyPresentation(world, value, renderComponent),
    };
  },
  async templateCandidate(world, load) {
    const { createTemplateCandidateFixture } = await load(
      "skills/template-candidate-fixtures/fixture.ts"
    );
    return createTemplateCandidateFixture(world);
  },
  async scratchHandoff(world, load) {
    const { createScratchHandoffFixture } = await load(
      "skills/scratch-handoff-fixtures/fixture.ts"
    );
    return createScratchHandoffFixture(world);
  },
  async automationLifecycle(world, load) {
    const { createAutomationLifecycleFixture, verifyAutomationLifecycle } = await load(
      "skills/automation-lifecycle-fixtures/fixture.ts"
    );
    const fixture = createAutomationLifecycleFixture(world);
    return {
      bindings: fixture.bindings,
      verify: (value) => verifyAutomationLifecycle(world, value, fixture.audit()),
    };
  },
  async google(world, load) {
    const [{ createGoogleWorkflowFixture }, { verifyGoogleWorkflowOutcome }] = await Promise.all([
      load("skills/google-drive/drive-workflow-fixture.ts"),
      load("skills/google-drive/drive-workflow-worlds.ts"),
    ]);
    const fixture = createGoogleWorkflowFixture(world);
    return {
      bindings: { googleWorkspaceRead: fixture.binding },
      verify: (value) =>
        fixture.readinessReads.length === 1 &&
        fixture.readinessReads[0].verify === true &&
        fixture.calls() === world.pages.length &&
        verifyGoogleWorkflowOutcome(world, value),
    };
  },
  async publication(world, load) {
    const [observations, { verifyPublicationOutcome }] = await Promise.all([
      load("skills/publish-preflight-fixtures/observations.json"),
      load("skills/publish-preflight-fixtures/worlds.ts"),
    ]);
    const observation = observations[world.id];
    if (!observation) throw new Error(`Missing publication observation for ${world.id}`);
    let reads = 0;
    return {
      bindings: {
        websiteReadback: {
          async observe() {
            reads++;
            return structuredClone(observation);
          },
        },
      },
      verify: (value) => reads === 1 && verifyPublicationOutcome(world, value, observation),
    };
  },
  async localModel(world, load) {
    const [{ createLocalModelTaskFixture }, { verifyLocalModelTask }] = await Promise.all([
      load("skills/local-model-task-fixtures/fixture.ts"),
      load("skills/local-model-task-fixtures/oracle.ts"),
    ]);
    const fixture = createLocalModelTaskFixture(world);
    return {
      bindings: fixture.bindings,
      verify: (value) => verifyLocalModelTask(world, value, fixture.audit()),
    };
  },
  async channelAgent(world, load) {
    const { membershipFixture, checkMembershipOutcome } = await load(
      "skills/channel-agent-membership-fixtures/fixture.ts"
    );
    const fixture = membershipFixture(world);
    return {
      bindings: fixture.services,
      verify: (value) => checkMembershipOutcome(world, value, fixture.evidence()),
    };
  },
  async pdfIntake(world, load) {
    const [{ createPdfIntakeFixture }, { verifyPdfIntake }] = await Promise.all([
      load("skills/pdf-intake-fixtures/fixture.ts"),
      load("skills/pdf-intake-fixtures/oracle.ts"),
    ]);
    const fixture = createPdfIntakeFixture(world);
    return {
      bindings: fixture.bindings,
      verify: (value) => verifyPdfIntake(world, value, fixture.operations()),
    };
  },
  async personal(world, load) {
    const { verifyPersonalWorld } = await load("skills/personal-workflows-fixtures/verify.ts");
    const requests = [];
    const bindings = world.work.some((item) => item.kind === "recallWorkspace")
      ? {
          memory: {
            async recall(input) {
              requests.push(structuredClone(input));
              return { results: structuredClone(world.memory) };
            },
          },
        }
      : {};
    return { bindings, verify: (value) => verifyPersonalWorld(world, value, requests) };
  },
  async system(world, load) {
    const { verifySystemInvestigation } = await load("skills/system-investigation-suite/oracle.ts");
    const bindings = {};
    if (world.evidence?.modelRows) {
      bindings.localModels = { listModels: async () => structuredClone(world.evidence.modelRows) };
    }
    if (world.evidence?.log) {
      bindings.serverLog = { query: async () => structuredClone(world.evidence.log) };
    }
    return { bindings, verify: (value) => verifySystemInvestigation(world, value) };
  },
  async combined(world, load) {
    const { verifySharedWorkflow } = await load("skills/shared-workflow-fixtures/verify.ts");
    return {
      bindings: {},
      verify: (value, calls) =>
        verifySharedWorkflow(
          world,
          value,
          calls.map((call) => ({
            name: call.name,
            startedAt: call.startedAt,
            endedAt: call.endedAt,
          }))
        ),
      wholeReport: true,
    };
  },
  async localReviewer(world, load) {
    const { bindChannelMembership } = await load("skills/agents/channelMembershipBoundary.ts");
    const assignment = world.request.work.find((item) => item.domain === "channelAgent").input;
    const installedId = "fixture-review-worker";
    let installed = false;
    let inventoryReads = 0;
    const membership = bindChannelMembership(assignment, {
      async roster() {
        return installed
          ? { state: "member", participantId: installedId }
          : { state: "absent", participantId: null };
      },
      async add() {
        installed = true;
        return { outcome: "acknowledged", participantId: installedId };
      },
      async remove() {
        throw new Error("No removal was assigned.");
      },
    });
    return {
      wholeReport: true,
      bindings: {
        ...membership,
        localModelTaskInventory: {
          async inspect(ref) {
            if (ref !== world.inventory.ref) throw new Error("Use the selected model.");
            inventoryReads++;
            return structuredClone(world.inventory);
          },
        },
      },
      verify(value, calls) {
        const [eligibility, effect] = value.results;
        const inspected =
          eligibility?.domain === "localModel" &&
          eligibility.report?.ref === world.inventory.ref &&
          eligibility.report?.state === world.inventory.state &&
          eligibility.report?.disposition === world.expected.disposition &&
          eligibility.report?.receipt === null &&
          inventoryReads === 1;
        if (!inspected) return false;
        if (!world.expected.attach)
          return (
            value.results.length === 1 &&
            eligibility.report.handoff === null &&
            !installed &&
            value.remaining.length > 0
          );
        return (
          value.results.length === 2 &&
          eligibility.report.handoff?.ref === world.inventory.ref &&
          eligibility.report.handoff?.mode === "fresh" &&
          effect?.domain === "channelAgent" &&
          effect.report?.status === "applied" &&
          effect.report?.participantId === installedId &&
          installed &&
          value.remaining.length === 0 &&
          calls[0].endedAt <= calls[1].startedAt
        );
      },
    };
  },
};

export function hasScopedWorkflowAdapter(family) {
  return Object.hasOwn(simple, family) || Object.hasOwn(bound, family);
}

export async function prepareScopedWorkflowAdapter(family, world, load) {
  if (Object.hasOwn(bound, family)) return bound[family](world, load);
  if (!Object.hasOwn(simple, family))
    throw new Error(`The ${family} family has no scoped workflow execution adapter`);
  const [file, name, expected = (value) => value] = simple[family];
  const verifier = (await load(file))[name];
  if (typeof verifier !== "function") throw new Error(`Missing verifier ${name} in ${file}`);
  return { bindings: {}, verify: (value) => verifier(expected(world), value) };
}

import { describe, expect, it } from "vitest";
import { GAD_RUNTIME_METHOD_NAMES } from "@vibestudio/shared/gadRuntimeMethods";
import {
  AgentHealthInspectionSchema,
  gadMethods,
  InspectAgentHealthInputSchema,
} from "./gad-schema.js";

describe("GAD runtime schema", () => {
  it("exactly implements the portable runtime method manifest", () => {
    expect(Object.keys(gadMethods)).toEqual([...GAD_RUNTIME_METHOD_NAMES]);
  });

  it("documents typed args, returns, and sensitivity for every method", () => {
    for (const [name, method] of Object.entries(gadMethods)) {
      expect(method.description, `${name} description`).toBeTruthy();
      expect(method.args.safeParse, `${name} args`).toBeTypeOf("function");
      expect(method.returns?.safeParse, `${name} returns`).toBeTypeOf("function");
      expect(method.access?.sensitivity, `${name} sensitivity`).toBeTruthy();
    }
  });

  it("keeps health request and result contracts strict", () => {
    expect(
      InspectAgentHealthInputSchema.safeParse({ channelId: "channel-1", typoLimit: 5 }).success
    ).toBe(false);
    expect(
      AgentHealthInspectionSchema.safeParse({
        channelId: "channel-1",
        branchId: "main",
        generatedAt: "2026-07-13T00:00:00.000Z",
        summary: {
          ok: true,
          durableIntegrityOk: true,
          inFlightOnly: false,
          activity: "idle",
          publicationIssues: 0,
          turnIntegrityIssues: 0,
          openTurns: 0,
          streamingMessages: 0,
          nonterminalInvocations: 0,
          activeParticipants: 1,
          storageIssues: 0,
        },
        publicationIntegrity: {
          summary: {
            expectedMappings: 0,
            missingMappings: 0,
            orphanMappings: 0,
            missingPublicationEvents: 0,
            missingPublicationEnvelopes: 0,
            sequenceMismatches: 0,
            channelOriginAgenticEnvelopes: 0,
          },
          rows: [],
        },
        turnState: {
          summary: {
            branches: 0,
            openTurns: 0,
            streamingMessages: 0,
            nonterminalInvocations: 0,
            duplicateOpenedTurns: 0,
          },
          rows: [],
        },
        invocationState: {
          summary: {
            projected: 0,
            startedEvents: 0,
            terminalEvents: 0,
            openProjectedInvocations: 0,
          },
          rows: [],
        },
        roster: {
          summary: { rows: 1, activeParticipants: 1, inactiveParticipants: 0 },
          rows: [],
        },
        envelopes: {
          items: [],
          pageInfo: {
            request: { window: { kind: "tail" }, limit: 5 },
            returnedCount: 0,
            totalCount: 0,
            hasMoreBefore: false,
            hasMoreAfter: false,
          },
        },
        storage: { rows: [] },
      }).success
    ).toBe(true);
  });

  it("does not duplicate semantic VCS graph methods on the trajectory service", () => {
    expect(gadMethods).not.toHaveProperty("provenanceForFile");
    expect(gadMethods).not.toHaveProperty("provenanceForSession");
    expect(gadMethods).not.toHaveProperty("walkProvenance");
  });
});

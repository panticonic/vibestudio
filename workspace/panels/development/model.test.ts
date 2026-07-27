import { describe, expect, it } from "vitest";
import {
  activeDevelopmentGrants,
  adoptedRepositoryId,
  appendUniquePage,
  dirtyStateLabel,
  instanceSummary,
  IntentLedger,
  knownEffects,
  latestLogLines,
  targetKey,
  targetLabel,
  VIBESTUDIO_PROJECT,
} from "./model.js";

describe("Development panel model", () => {
  it("uses the credential-free canonical upstream without turning adoption into implicit refresh", () => {
    expect(VIBESTUDIO_PROJECT).toEqual({
      path: "projects/vibestudio",
      remote: { name: "origin", url: "https://github.com/panticonic/vibestudio", branch: "main" },
    });
  });

  it("uses the repository identity admitted by atomic import evidence", () => {
    const imported = {
      candidate: {
        semanticEvidence: {
          externalSnapshot: {
            targetRepositoryIds: ["repository:projects/vibestudio"],
          },
        },
      },
    } as never;
    expect(adoptedRepositoryId(imported)).toBe("repository:projects/vibestudio");
    expect(() =>
      adoptedRepositoryId({
        candidate: {
          semanticEvidence: {
            externalSnapshot: {
              targetRepositoryIds: ["repository:first", "repository:second"],
            },
          },
        },
      } as never)
    ).toThrow("exactly one repository");
  });

  it("only exposes canonical development execution grants for revocation", () => {
    expect(
      activeDevelopmentGrants([
        { id: "development", kind: "capability", callerLabel: "Development", scopeLabel: "build", capability: "development.native.execute", why: "build", approvedBy: "me", duration: "30 days", revokeEffect: "stop future builds" },
        { id: "other", kind: "capability", callerLabel: "Other", scopeLabel: "other", capability: "git.pull", why: "pull", approvedBy: "me", duration: "session", revokeEffect: "none" },
      ])
    ).toHaveLength(1);
  });

  it("renders only durable log lines and truthful repair effects", () => {
    expect(latestLogLines([{ sequence: 1, at: 1, kind: "log", payload: { line: "build ok" } }, { sequence: 2, at: 2, kind: "diagnostic", payload: { line: "not a log" } }])).toEqual(["build ok"]);
    expect(knownEffects({ repair: { knownEffects: { executionRoot: "owned", process: "unknown", artifact: "retained" } } } as never)).toEqual(["executionRoot: owned", "process: unknown", "artifact: retained"]);
  });

  it("replays an ambiguous click but makes the next click new after durable observation", () => {
    const ledger = new IntentLedger();
    let count = 0;
    const create = () => `intent-${++count}`;
    expect(ledger.idFor("start:session", create)).toBe("intent-1");
    expect(ledger.idFor("start:session", create)).toBe("intent-1");
    ledger.settle("start:session");
    expect(ledger.idFor("start:session", create)).toBe("intent-2");
  });

  it("keeps target choices typed and renders only durable instance facts", () => {
    expect(targetKey({ kind: "build-only" })).toBe("build-only");
    expect(targetLabel({ kind: "current-host-client", client: "electron" })).toBe(
      "Current host Electron client"
    );
    expect(targetLabel({ kind: "isolated-host", includeClient: true })).toBe(
      "Isolated host with client"
    );
    expect(
      instanceSummary({
        instanceId: "development-run",
        generationId: "0123456789abcdef0123456789abcdef",
        lifecycle: "ephemeral",
        state: "ready",
        executionDigest: "0".repeat(64),
        serverBuildId: "1".repeat(64),
        serverId: "server",
        serverBootId: "boot",
        workspaceId: "workspace",
        workspaceName: "Development",
        gatewayUrl: "http://127.0.0.1:1234",
        registeredAt: 1,
        readyAt: 2,
        stoppedAt: null,
      })
    ).toContain("generation 0123456789abcdef0123456789abcdef");
  });

  it("derives dirty state from the durable parent working-head before route hints", () => {
    expect(
      dirtyStateLabel(
        { basis: { parentWorkingHead: { kind: "application", applicationId: "application:dirty" } } } as never,
        false
      )
    ).toBe("Uncommitted semantic changes included");
    expect(
      dirtyStateLabel(
        { basis: { parentWorkingHead: { kind: "event", eventId: "event:clean" } } } as never,
        true
      )
    ).toBe("Clean committed semantic state");
    expect(dirtyStateLabel(null, true)).toBe("Uncommitted semantic changes included");
    expect(dirtyStateLabel(null, undefined)).toContain("not available");
  });

  it("appends bounded cursor pages without duplicating the boundary row", () => {
    expect(
      appendUniquePage(
        [{ id: "newest" }, { id: "boundary" }],
        [{ id: "boundary" }, { id: "older" }],
        (value) => value.id
      )
    ).toEqual([{ id: "newest" }, { id: "boundary" }, { id: "older" }]);
  });
});

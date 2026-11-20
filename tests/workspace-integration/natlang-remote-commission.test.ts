import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProgramLoader } from "@exact-userland/packages/natlang/src/programs";
import { confinedRealm } from "@exact-userland/packages/natlang/src/realm";
import { testNewFunction } from "@exact-userland/packages/natlang/src/testSupport";
import {
  createNatlangRuntime,
  workerdPlatform,
} from "@exact-userland/packages/natlang/vendor/workerd/natlang-workerd.js";
import { remoteCommissionReferenceSteps } from "@exact-userland/skills/remote-commission-fixtures/reference";
import { withRemoteCommissionSmoke } from "../../scripts/smoke-remote-deployment-readiness";

const instance = process.env["VIBESTUDIO_REMOTE_COMMISSION_INSTANCE"];

it.runIf(Boolean(instance))(
  "commissions a real child workspace through the mounted Natlang tree",
  async () => {
    const workspace = process.env["VIBESTUDIO_USERLAND_ROOT"]!;
    const platform = workerdPlatform({ realm: confinedRealm(testNewFunction()) });
    const calls: string[] = [];
    const leafServices: Record<string, string[]> = {
      observeBaseline: ["remoteDeploymentRead"],
      bindVerifiedWorkspace: ["remoteDeploymentHandoff"],
      readAssignedProfile: ["remoteAccessRead"],
      pairAssignedProfile: ["remoteAccessPair"],
      routeThroughHub: ["remoteAccessRoute"],
      observeChild: ["remoteAccessVerify"],
    };
    const runtime = createNatlangRuntime({
      platform,
      agent: async (session) => {
        const name = session.lam.functionName!;
        expect(Object.keys(session.availableServices()), name).toEqual(leafServices[name] ?? []);
        calls.push(name);
        const code = remoteCommissionReferenceSteps[name];
        if (!code) throw new Error(`Unexpected remote commissioning call ${name}`);
        const action = await session.applyAsync("eval", { code, finish: true });
        if (action.kind === "error" || action.kind === "rejected") throw new Error(action.text);
      },
    });
    const loader = new ProgramLoader({
      platform,
      fs: {
        readFile: (path) => readFile(join(workspace, path), "utf8"),
        readdir: (path) => readdir(join(workspace, path), { withFileTypes: true }),
        stat: (path) => stat(join(workspace, path)),
      },
      bindings: {},
      runTask: (run, task) => runtime.run(run, task),
    });
    await withRemoteCommissionSmoke(
      instance!,
      async ({ request, services, workspaceId, assertPairedProfile }) => {
        const root = (await loader.load("skills/vibestudio-workflows/runWorkflow.nl", {
          services,
        })) as (input: unknown) => Promise<{
          results: Array<{ report: { handoff: { operationId: string } } }>;
          remaining: unknown[];
        }>;
        const result = await root({
          goal: "Check the assigned hub and open its verified workspace on this device",
          work: [
            {
              kind: "domain",
              domain: "remoteAccess",
              operation: "commissionRemoteWorkspace",
              input: request,
            },
          ],
        });
        const operationId = result.results[0]?.report.handoff.operationId;
        expect(result).toMatchObject({
          remaining: [],
          results: [
            {
              domain: "remoteAccess",
              operation: "commissionRemoteWorkspace",
              report: {
                deployment: {
                  status: "already-running",
                  identity: null,
                  evidenceIds: [`${request.operationId}:baseline`],
                },
                handoff: { state: "assigned", operationId: expect.any(String) },
                access: {
                  status: "workspace-ready",
                  workspaceId,
                  evidenceIds: ["profile", "pair", "route", "child"].map(
                    (stage) => `${operationId}:${stage}`
                  ),
                },
              },
            },
          ],
        });
        assertPairedProfile();
      }
    );
    expect(calls).toEqual([
      "runWorkflow",
      "commissionRemoteWorkspace",
      "deployRemoteServer",
      "observeBaseline",
      "decideDeployment",
      "bindVerifiedWorkspace",
      "openRemoteWorkspace",
      "readAssignedProfile",
      "decideAdmission",
      "pairAssignedProfile",
      "openAssignedRoute",
      "routeThroughHub",
      "observeChild",
      "interpretChild",
    ]);
  },
  90_000
);

import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { OnboardingHostTopologySnapshotSchema } from "@vibestudio/service-schemas/onboardingStatus";
import { createOnboardingStatusService } from "./onboardingStatusService.js";

const codeContext: ServiceContext = {
  caller: createVerifiedCaller("do:onboarding", "do"),
};

describe("onboardingStatusService", () => {
  it("projects only redacted topology from the host-owned hub session", async () => {
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "listDevices") {
        return {
          serverId: "secret-server-id",
          devices: [
            {
              deviceId: "secret-device-id",
              userId: "secret-user-id",
              label: "Private device label",
              createdAt: 1,
            },
          ],
        };
      }
      if (method === "listWorkspaces") {
        return [
          {
            workspaceId: "secret-workspace-id",
            name: "Private workspace",
            lastOpened: 1,
            running: true,
          },
        ];
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = createOnboardingStatusService({
      client: { call } as never,
      getConnectionMode: () => "remote",
    });

    const result = await service.handler(codeContext, "read", []);

    expect(result).toEqual({
      devices: {
        availability: "available",
        pairedDeviceCount: 1,
        thisDevicePaired: true,
      },
      remote: {
        availability: "available",
        route: "remote",
        workspaceCount: 1,
      },
    });
    expect(OnboardingHostTopologySnapshotSchema.parse(result)).toEqual(result);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /deviceId|workspaceId|serverId|pairUrl|deepLink|presence|profile|Private|secret/iu
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("fault-isolates the two host topology reads", async () => {
    const service = createOnboardingStatusService({
      client: {
        call: vi.fn(async (_service: string, method: string) => {
          if (method === "listDevices") throw new Error("devices unavailable");
          return [];
        }),
      } as never,
      getConnectionMode: () => "local",
    });

    await expect(service.handler(codeContext, "read", [])).resolves.toEqual({
      devices: {
        availability: "unknown",
        pairedDeviceCount: 0,
        thisDevicePaired: false,
      },
      remote: {
        availability: "available",
        route: "local",
        workspaceCount: 0,
      },
    });
  });

  it("is reachable by the onboarding code runtime through the reviewed open read", async () => {
    const service = createOnboardingStatusService({
      client: {
        call: vi.fn(async (_service: string, method: string) =>
          method === "listDevices" ? { serverId: "server-1", devices: [] } : []
        ),
      } as never,
      getConnectionMode: () => "local",
    });
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(codeContext, "onboardingStatus", "read", [])).resolves.toEqual(
      {
        devices: {
          availability: "available",
          pairedDeviceCount: 0,
          thisDevicePaired: false,
        },
        remote: {
          availability: "available",
          route: "local",
          workspaceCount: 0,
        },
      }
    );
  });
});

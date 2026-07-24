import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import {
  onboardingStatusMethods,
  type OnboardingHostTopologySnapshot,
} from "@vibestudio/service-schemas/onboardingStatus";
import type { ServerClient } from "../serverClient.js";

export function createOnboardingStatusService(deps: {
  client: ServerClient;
  getConnectionMode: () => "local" | "remote";
}): ServiceDefinition {
  const hub = createTypedServiceClient("hubControl", hubControlMethods, (service, method, args) =>
    deps.client.call(service, method, args)
  );
  return {
    name: "onboardingStatus",
    description: "Redacted host topology for the workspace onboarding projection",
    authority: { principals: ["user", "host", "code"] },
    methods: onboardingStatusMethods,
    handler: defineServiceHandler("onboardingStatus", onboardingStatusMethods, {
      read: async (): Promise<OnboardingHostTopologySnapshot> => {
        const [devices, workspaces] = await Promise.allSettled([
          hub.listDevices(),
          hub.listWorkspaces(),
        ]);
        const deviceList = devices.status === "fulfilled" ? devices.value.devices : null;
        const workspaceList = workspaces.status === "fulfilled" ? workspaces.value : null;
        return {
          devices: {
            availability: deviceList ? "available" : "unknown",
            pairedDeviceCount: deviceList?.length ?? 0,
            // A successful authenticated listDevices call is itself proof that
            // this shell holds a paired device relationship. No device id is
            // needed or allowed in the projection.
            thisDevicePaired: deviceList !== null && deviceList.length > 0,
          },
          remote: {
            availability: workspaceList ? "available" : "unknown",
            route: deps.getConnectionMode(),
            workspaceCount: workspaceList?.length ?? 0,
          },
        };
      },
    }),
  };
}

import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  createEventsServiceDefinition,
  type EventsServiceDefinitionOptions,
} from "@vibestudio/service-schemas/bindings/eventsServiceDefinition";

export interface DesktopEventsServiceDeps extends Omit<
  EventsServiceDefinitionOptions,
  "serviceName"
> {
  eventService: EventService;
}

/**
 * Electron-owned event domain. It combines native UI state with the explicit
 * projection of workspace events retained by the desktop bridge.
 */
export function createDesktopEventsService(deps: DesktopEventsServiceDeps): ServiceDefinition {
  return createEventsServiceDefinition(deps.eventService, {
    serviceName: "desktopEvents",
    snapshots: deps.snapshots,
    onWatchOpened: deps.onWatchOpened,
  });
}

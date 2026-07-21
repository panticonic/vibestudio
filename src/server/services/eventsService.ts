import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  createEventsServiceDefinition,
  type EventsServiceDefinitionOptions,
} from "@vibestudio/service-schemas/bindings/eventsServiceDefinition";

export interface WorkspaceEventsServiceDeps extends Omit<
  EventsServiceDefinitionOptions,
  "serviceName"
> {
  eventService: EventService;
}

/**
 * Server-owned workspace event domain. Keeping the canonical endpoint behind
 * a server service factory makes it part of the complete authority census and
 * therefore of the generated product-grant catalog used at dispatch time.
 */
export function createWorkspaceEventsService(deps: WorkspaceEventsServiceDeps): ServiceDefinition {
  return createEventsServiceDefinition(deps.eventService, {
    snapshots: deps.snapshots,
    onWatchOpened: deps.onWatchOpened,
  });
}

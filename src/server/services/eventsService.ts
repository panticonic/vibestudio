/**
 * Server-hosted events service entrypoint.
 *
 * The concrete binder is shared with Electron, while this host-local export
 * keeps the service inside the complete server authority census.
 */
export { createEventsServiceDefinition } from "@vibestudio/service-schemas/bindings/eventsServiceDefinition";

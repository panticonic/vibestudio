/**
 * Electron-hosted events service entrypoint.
 *
 * The concrete binder is shared with the server, while this host-local export
 * keeps the service inside the complete Electron authority census.
 */
export { createEventsServiceDefinition } from "@vibestudio/service-schemas/bindings/eventsServiceDefinition";

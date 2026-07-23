/**
 * Trusted-host source reader contracts.
 *
 * These types describe local browser files and profiles and intentionally live
 * outside the userland package root. They are implementation details of import
 * providers; panels and extension callers use only the opaque contracts from
 * `environment.ts`.
 */
export * from "./types.js";

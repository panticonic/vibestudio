/**
 * Launcher surface of the client <-> host wire (capability `integration.install`,
 * docs/client-hosts-and-clients-plan.md 4.7 "Installing a launcher").
 *
 * Installing a launcher is host-mediated and person-initiated: a client asks,
 * the OS confirms with the person in its own UI, and the host records every
 * launcher it wrote so it can remove it when the client is retired. A client
 * can only ask for a launcher of a client this device can run; it cannot write
 * an arbitrary shortcut.
 */
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";

/** A launcher the OS confirmed. `link` is the `vibestudio://c/<id>/<intent>` link it opens. */
export interface InstalledLauncher {
  /** Stable per (client, intent, params). */
  launcherId: string;
  clientId: string;
  label: string;
  link: string;
}

/**
 * What asking for a launcher did. `requested` means the OS launcher accepted
 * the request and is now asking the person; whether they agreed arrives as an
 * `integration-launchers` event (a person can also decline, which the OS does
 * not report). `unsupported` means this launcher cannot pin shortcuts at all.
 */
export type InstallLauncherOutcome = "requested" | "unsupported";

export interface IntegrationHostMethods {
  /** Ask the OS launcher to add the `open` launcher of client `id`. */
  "integration.install": {
    args: [request: { id: string }];
    result: { outcome: InstallLauncherOutcome };
  };
  /** The launchers on this device that the host wrote and the OS confirmed. */
  "integration.list": { args: []; result: InstalledLauncher[] };
  /** Disable the launchers of client `id` (an OS cannot delete a pinned shortcut; it can disable it). */
  "integration.remove": { args: [request: { id: string }]; result: void };
}

export type IntegrationHostEvent = {
  type: "integration-launchers";
  launchers: InstalledLauncher[];
};

export const INTEGRATION_METHOD_CAPABILITY: Readonly<
  Record<keyof IntegrationHostMethods, ClientCapability>
> = {
  "integration.install": "integration.install",
  "integration.list": "integration.install",
  "integration.remove": "integration.install",
};

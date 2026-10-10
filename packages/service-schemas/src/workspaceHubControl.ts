/** The deliberately narrow hub-control surface available to workspace children. */
import { hubControlMethods } from "./hubControl.js";
import { workspaceCreationMethods } from "./workspaceCreation.js";

export const workspaceHubControlMethods = {
  ...workspaceCreationMethods,
  observeDevices: hubControlMethods.observeDevices,
};

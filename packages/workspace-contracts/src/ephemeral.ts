/** One logical workspace name for every hub-owned disposable development checkout. */
export const EPHEMERAL_DEV_WORKSPACE_NAME = "dev";

/** Begin a fresh disposable workspace lifecycle from an external developer command. */
export const EPHEMERAL_WORKSPACE_ARG = "--ephemeral-workspace";

/** Retain that lifecycle across an internal Electron relaunch. */
export const RESUME_EPHEMERAL_WORKSPACE_ARG = "--resume-ephemeral-workspace";

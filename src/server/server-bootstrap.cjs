"use strict";

const path = require("node:path");

const appRoot = process.env.NATSTACK_APP_ROOT;
if (!appRoot) {
  throw new Error("NATSTACK_APP_ROOT must be set before starting the NatStack server");
}

require(path.join(appRoot, "dist", "server-electron.cjs"));

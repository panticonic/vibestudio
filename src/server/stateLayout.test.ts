import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stateLayout } from "./stateLayout.js";

describe("stateLayout", () => {
  it("declares workspace-root storage paths", () => {
    const root = path.join("tmp", "workspace", "state");
    const layout = stateLayout(root);
    expect(layout.root).toBe(root);
    expect(layout.contextsDir).toBe(path.join(root, ".contexts"));
    expect(layout.databases.workerdDoDir).toBe(path.join(root, ".databases", "workerd-do"));
    expect(layout.webrtc.routesFile).toBe(path.join(root, "webrtc", "routes.json"));
    expect(layout.units.metaApprovalGrantsFile).toBe(
      path.join(root, "units", "meta-approval-grants.json")
    );
  });
});

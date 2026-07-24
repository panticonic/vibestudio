import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_PROJECTION_EPOCH,
  CONTEXT_PROJECTION_NAMESPACE,
  currentContextProjectionsPath,
} from "@vibestudio/workspace/contextProjections";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";
import { stateLayout } from "./stateLayout.js";

describe("stateLayout", () => {
  it("declares workspace-root storage paths", () => {
    const root = path.join("tmp", "workspace", "state");
    const layout = stateLayout(root);
    expect(layout.root).toBe(root);
    expect(CONTEXT_PROJECTION_EPOCH).toBe(6);
    expect(CONTEXT_PROJECTION_NAMESPACE).toBe("v6");
    expect(layout.contextProjections).toEqual({
      base: path.join(root, ".context-projections"),
      current: path.join(root, ".context-projections", "v6"),
    });
    expect(currentContextProjectionsPath(root)).toBe(layout.contextProjections.current);
    expect(layout.gitCheckoutsDir).toBe(gitCheckoutsPath(root));
    expect(layout.databases.workerdDoDir).toBe(path.join(root, ".databases", "workerd-do"));
  });
});

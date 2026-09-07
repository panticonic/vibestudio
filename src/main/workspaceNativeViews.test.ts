import { describe, expect, it, vi } from "vitest";
import type { ViewManager } from "./viewManager.js";
import {
  WorkspaceNativeViews,
  parseWorkspaceNativeViewId,
  workspaceNativeViewId,
} from "./workspaceNativeViews.js";

describe("workspace-qualified native view boundary", () => {
  it("keeps equal local runtime IDs distinct, including delimiter-like IDs", () => {
    const left = workspaceNativeViewId({ workspaceId: "a:b", runtimeId: "c" });
    const right = workspaceNativeViewId({ workspaceId: "a", runtimeId: "b:c" });
    expect(left).not.toBe(right);
    expect(parseWorkspaceNativeViewId(left)).toEqual({ workspaceId: "a:b", runtimeId: "c" });
    expect(parseWorkspaceNativeViewId("workspace:[1,2]")).toBeNull();
    expect(parseWorkspaceNativeViewId("shell")).toBeNull();
  });

  it("addresses native view creation and its parent inside the owning workspace", () => {
    const window = { createView: vi.fn(), destroyView: vi.fn() };
    const project = new WorkspaceNativeViews("project", window as unknown as ViewManager);
    const personal = new WorkspaceNativeViews("personal", window as unknown as ViewManager);
    project.createView({ id: "panel", type: "panel", parentId: "root" });
    personal.createView({ id: "panel", type: "panel" });
    project.destroyView("panel");
    expect(window.createView.mock.calls[0]?.[0]).toEqual({
      id: project.nativeId("panel"),
      workspaceIdentity: { workspaceId: "project", runtimeId: "panel" },
      type: "panel",
      parentId: project.nativeId("root"),
    });
    expect(window.createView.mock.calls[1]?.[0].id).toBe(personal.nativeId("panel"));
    expect(window.destroyView).toHaveBeenCalledWith(project.nativeId("panel"));
    expect(window.destroyView).not.toHaveBeenCalledWith(personal.nativeId("panel"));
  });

  it("does not turn another workspace's WebContents into a local caller", () => {
    const window = {
      findViewIdByWebContentsId: vi.fn(() =>
        workspaceNativeViewId({ workspaceId: "personal", runtimeId: "panel" })
      ),
    };
    const project = new WorkspaceNativeViews("project", window as unknown as ViewManager);
    const personal = new WorkspaceNativeViews("personal", window as unknown as ViewManager);
    expect(project.findViewIdByWebContentsId(10)).toBeNull();
    expect(personal.findViewIdByWebContentsId(10)).toBe("panel");
  });
});

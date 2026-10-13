import { describe, expect, it } from "vitest";

import { mobileApprovalSurfaceState } from "../scripts/cli/lib/mobile-approval-surface.mjs";

describe("mobile approval surface lifecycle", () => {
  it("keeps a disabled install review owned while its decision lands", () => {
    const xml = `<hierarchy>
      <node content-desc="Dismiss approval" resource-id="approval-action-dismiss" enabled="true" clickable="true" />
      <node text="Add to workspace" resource-id="approval-action-accept-install-review" enabled="false" clickable="true" />
    </hierarchy>`;

    expect(mobileApprovalSurfaceState(xml)).toEqual({
      visible: true,
      loadRemainingKey: null,
    });
  });

  it("exposes the explicit action that reconnects unloaded approval owners", () => {
    const xml = `<hierarchy>
      <node text="Dismiss approval" enabled="true" clickable="true" />
      <node text="More reviews in System." enabled="true" clickable="false" />
      <node text="Load remaining reviews" enabled="true" clickable="true" />
    </hierarchy>`;

    expect(mobileApprovalSurfaceState(xml)).toEqual({
      visible: true,
      loadRemainingKey: "More reviews in System.",
    });
  });

  it("does not mistake the mounted Personal chat for an approval", () => {
    const xml = `<hierarchy>
      <node text="Personal" enabled="true" clickable="false" />
      <node text="panels/chat" enabled="true" clickable="false" />
    </hierarchy>`;

    expect(mobileApprovalSurfaceState(xml)).toEqual({
      visible: false,
      loadRemainingKey: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import { cdpDefaultHostAssignmentError } from "./panelRuntimeRegistration.js";

describe("cdpDefaultHostAssignmentError", () => {
  it("classifies non-CDP mobile holders distinctly", () => {
    const error = cdpDefaultHostAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe(
      "CDP is unavailable while panel slot-mobile is held by a non-CDP host"
    );
    expect(error.code).toBe("cdp_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = cdpDefaultHostAssignmentError(
      "panel:tree/slot-a",
      "no_default_cdp_host"
    ) as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: panel:tree/slot-a");
    expect(error.code).toBe("cdp_no_default_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(cdpDefaultHostAssignmentError("panel:tree/slot-a", "already_held")).toBeNull();
  });
});

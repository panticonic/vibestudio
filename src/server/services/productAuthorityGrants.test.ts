import { describe, expect, it } from "vitest";
import {
  productCodeHasCapability,
  productPrincipalHasCapability,
} from "./productAuthorityGrants.js";

const GAD_CAPABILITY = "workspace-service:gad.workspace";

describe("product-sealed GAD workspace service grants", () => {
  it("grants the service to the host and authenticated workspace user principals", () => {
    expect(productPrincipalHasCapability("host", GAD_CAPABILITY)).toBe(true);
    expect(productPrincipalHasCapability("user", GAD_CAPABILITY)).toBe(true);
  });

  it("does not broaden the service to device or entity principals", () => {
    expect(productPrincipalHasCapability("device", GAD_CAPABILITY)).toBe(false);
    expect(productPrincipalHasCapability("entity", GAD_CAPABILITY)).toBe(false);
  });

  it("grants reviewed product code the same exact service capability", () => {
    expect(productCodeHasCapability("product/bootstrap", GAD_CAPABILITY)).toBe(true);
  });

  it("grants internal DO code only capabilities present in reviewed class manifests", () => {
    expect(
      productCodeHasCapability("vibestudio/internal", "service:workspace-state.alarmClear")
    ).toBe(true);
    expect(
      productCodeHasCapability("vibestudio/internal", "service:notification.signalUserInbox")
    ).toBe(true);
    expect(productCodeHasCapability("vibestudio/internal", "service:credentials.list")).toBe(false);
  });

  it("makes an explicitly delegated baseline available without widening direct requests", () => {
    expect(productCodeHasCapability("workers/system-test-runner", "service:build.getBuild")).toBe(
      true
    );
  });
});

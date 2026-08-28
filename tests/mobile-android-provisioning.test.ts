import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const provisioning = readFileSync(
  "apps/mobile/android/app/src/main/java/app/vibestudio/mobile/ProvisioningActivity.kt",
  "utf8"
);
const main = readFileSync(
  "apps/mobile/android/app/src/main/java/app/vibestudio/mobile/MainActivity.kt",
  "utf8"
);
const nativeHost = readFileSync(
  "apps/mobile/android/app/src/main/java/app/vibestudio/mobile/VibestudioMobileHostModule.kt",
  "utf8"
);

describe("Android USB provisioning activity lifecycle", () => {
  it("reuses the native-bootstrap task instead of clearing an in-flight pairing root", () => {
    expect(provisioning).toContain(
      "Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP"
    );
    expect(provisioning).not.toContain(
      "Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK"
    );
    expect(main).toMatch(
      /if \(clearActiveBundleForConnectIntent\(intent\)\) \{[\s\S]*restartWithIntent\(intent\)[\s\S]*\} else \{[\s\S]*super\.onNewIntent\(intent\)/u
    );
  });

  it("binds approval to the carrier-independent compact pairing payload", () => {
    expect(provisioning).toContain("fun pairingApprovalDigest(pairUrl: String): String?");
    expect(provisioning).toContain('uri.scheme?.lowercase() == "vibestudio"');
    expect(provisioning).toContain('uri.scheme?.lowercase() == "https"');
    expect(provisioning).toContain('MessageDigest.getInstance("SHA-256")');
    expect(provisioning).toContain("compactPayload.toByteArray(Charsets.US_ASCII)");
    expect(provisioning).not.toContain(".putString(PAIR_URL_DIGEST, digest(pairUrl))");
    expect(nativeHost).toContain("ProvisioningActivity.pairingApprovalDigest(pairUrl)");
  });

  it("durably records USB approval before an active workspace can restart the process", () => {
    expect(provisioning).toContain(".commit()");
    expect(provisioning).not.toMatch(/putLong\(APPROVED_AT,[\s\S]*?\.apply\(\)/u);
  });
});

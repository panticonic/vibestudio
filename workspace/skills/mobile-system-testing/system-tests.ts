import type { TestCase } from "@workspace-skills/system-testing";
import {
  completedScenarioEvidence,
  findLastAgentMessage,
  requireCodeOperations,
  walkRecords,
} from "@workspace-skills/system-testing/scenario-validation";

export const mobileTests: TestCase[] = [
  {
    name: "onboarding-desktop-mobile-install-android",
    description:
      "Install and immediately pair the mobile client through onboarding, a connected Electron desktop, and an attached Android device",
    category: "mobile",
    resources: ["mobile:android-device"],
    authorityPolicy: {
      authority: [
        {
          ruleId: "onboarding-desktop-mobile-discovery",
          capability: { kind: "exact", key: "mobile.devices.read" },
          resource: { kind: "exact", key: "mobile.devices.read" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "onboarding-desktop-mobile-provision",
          capability: { kind: "exact", key: "mobile.provision" },
          resource: { kind: "exact", key: "mobile.provision" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt: [
      "Set up Vibestudio on the Android device attached to my connected desktop.",
      "Follow the complete documented phone onboarding workflow, install only when needed, pair it immediately, and confirm afterward that the compatible app appears as a newly paired hub device.",
      "Because this is a repository system test, capture the start time before provisioning and then use the documented mobile-debug verifyWorkspaceReady operation with its 180000ms cold-build deadline for the same device to prove that the app completed workspace and panel-host initialization.",
    ].join(" "),
    validate: (result) => {
      const base = completedScenarioEvidence(result);
      if (!base.passed) return base;
      const exercised = requireCodeOperations(base.evidence.evalCode, [
        [
          "vibestudio.phone-provisioning.v1",
          "resolveService",
          "\"providers\"",
          "\"devices\"",
          "\"provision\"",
          "extensions.invoke",
          "mobile-debug",
          "verifyWorkspaceReady",
        ],
      ]);
      if (!exercised.passed) return exercised;

      const records = walkRecords(base.evidence.evalValues);
      const installCompleted = records.some((record) =>
        ["installed", "already-compatible"].includes(String(record["installStatus"]))
      );
      const compatibleAfter = records.some((record) => record["compatibleAppInstalled"] === true);
      const pairingCompleted = records.some((record) => record["pairingStatus"] === "paired");
      const pairedAndroid = records.some(
        (record) =>
          record["pairingStatus"] === "paired" &&
          record["platform"] === "android" &&
          typeof record["pairedDevice"] === "object" &&
          record["pairedDevice"] !== null
      );
      const workspaceReady = records.some(
        (record) =>
          record["ready"] === true &&
          record["workspaceConnected"] === true &&
          record["panelHostReady"] === true &&
          Array.isArray(record["issues"]) &&
          record["issues"].length === 0
      );
      if (
        !installCompleted ||
        !compatibleAfter ||
        !pairingCompleted ||
        !pairedAndroid ||
        !workspaceReady
      ) {
        return {
          passed: false,
          reason:
            "Provisioning results did not prove install compatibility, pairing, a paired Android hub device, and a ready mobile workspace host",
        };
      }

      const final = findLastAgentMessage(result);
      return /android|device/iu.test(final) &&
        /install/iu.test(final) &&
        /compatible/iu.test(final) &&
        /pair|connect/iu.test(final) &&
        /workspace|panel|ready/iu.test(final)
        ? { passed: true }
        : {
            passed: false,
            reason: "Final response omitted provider/device/install/pairing/readiness evidence",
          };
    },
  },
  {
    name: "mobile-extension-install-android",
    description:
      "Install and launch the development mobile client on the attached Android device through sandboxed eval and the mobile-debug extension",
    category: "mobile",
    resources: ["mobile:android-device"],
    authorityPolicy: {
      authority: [
        {
          ruleId: "mobile-native-execution",
          capability: {
            kind: "prefix",
            prefix: "userland:extensions/mobile-debug/native.mobile.execute#",
          },
          resource: {
            kind: "exact",
            key: "native.mobile:extension:@workspace-extensions/mobile-debug",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt: [
      "Install a fresh development Vibestudio mobile client on the single attached ready Android phone or emulator, reset its app data, and launch it.",
      "Use the workspace's documented mobile debugging workflow from sandboxed eval; do not shell out or call adb directly.",
      "After installation, verify through the same supported extension surface that the package is installed and its process is rendering.",
      "Report the selected device, installed package, installation result, and verification result.",
    ].join(" "),
    validate: (result) => {
      const base = completedScenarioEvidence(result);
      if (!base.passed) return base;
      const exercised = requireCodeOperations(base.evidence.evalCode, [
        ["extensions.invoke", "mobile-debug", "installAndroid", "verify"],
      ]);
      if (!exercised.passed) return exercised;

      const records = walkRecords(base.evidence.evalValues);
      const installedPackage = records.some(
        (record) => record["packageName"] === "app.vibestudio.mobile.internal"
      );
      const verified = records.some(
        (record) =>
          record["installed"] === true &&
          record["rendering"] === true &&
          Array.isArray(record["issues"]) &&
          record["issues"].length === 0
      );
      if (!installedPackage || !verified) {
        return {
          passed: false,
          reason:
            "Extension results did not prove that the internal package was installed, launched, and rendering without issues",
        };
      }

      const final = findLastAgentMessage(result);
      return /android|emulator|device/iu.test(final) &&
        /app\.vibestudio\.mobile\.internal/u.test(final) &&
        /install/iu.test(final) &&
        /render/iu.test(final)
        ? { passed: true }
        : {
            passed: false,
            reason:
              "Final response omitted the selected device, package, install, or rendering evidence",
          };
    },
  },
];

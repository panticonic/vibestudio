import { test } from "@playwright/test";
import { websiteInventionScenario } from "../../setup/websiteInventionScenario";
import { inventorModelScript } from "../../fixtures/inventorModelScript";

test("scripted inventor exercises the real connected website and workspace tools", async () => {
  await websiteInventionScenario({
    VIBESTUDIO_TEST_MODE: "1",
    VIBESTUDIO_TEST_MODEL_SCRIPT: JSON.stringify(inventorModelScript),
  });
});

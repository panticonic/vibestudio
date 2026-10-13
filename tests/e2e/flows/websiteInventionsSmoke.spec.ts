import {
  websiteInventionScenario,
  websiteInventionTest as test,
} from "../../setup/websiteInventionScenario";
import { inventorModelScript } from "../../fixtures/inventorModelScript";

test.use({
  websiteInventionEnvironment: {
    VIBESTUDIO_TEST_MODE: "1",
    VIBESTUDIO_TEST_MODEL_SCRIPT: JSON.stringify(inventorModelScript),
  },
});

test("scripted inventor exercises the real connected website and workspace tools", async ({
  websiteInvention,
}) => {
  await websiteInventionScenario(websiteInvention);
});

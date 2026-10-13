import {
  websiteInventionScenario,
  websiteInventionTest as test,
} from "../setup/websiteInventionScenario";

test("local invention website builds, operates and revises a real embedded agentic app", async ({
  websiteInvention,
}) => {
  await websiteInventionScenario(websiteInvention);
});

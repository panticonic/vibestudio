import { test } from "@playwright/test";
import { websiteInventionScenario } from "../setup/websiteInventionScenario";

test("local invention website builds, operates and revises a real embedded agentic app", async () => {
  await websiteInventionScenario();
});

import { ResolvedWorkspaceServiceSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { z } from "zod";

type DurableObjectService = Extract<
  z.infer<typeof ResolvedWorkspaceServiceSchema>,
  { kind: "durable-object" }
>;

/** A complete service-resolution fixture, checked by the real receiver schema. */
export function durableObjectServiceFixture(
  targetId: string,
  overrides: Partial<DurableObjectService> = {}
): DurableObjectService {
  const candidate: DurableObjectService = {
    kind: "durable-object",
    origin: "workspace",
    source: "workers/test-service",
    name: "test-service",
    action: "provide",
    presentation: { domain: "web", verb: "see" },
    authority: { principals: ["code"] },
    protocols: ["test.service.v1"],
    className: "TestServiceDO",
    objectKey: "test",
    targetId,
    ...overrides,
  };
  const service = ResolvedWorkspaceServiceSchema.parse(candidate);
  if (service.kind !== "durable-object") {
    throw new Error("A Durable Object fixture requires a Durable Object service");
  }
  return service;
}

import { describe, expect, it } from "vitest";
import { planServiceMutation, type ServiceRegistration } from "./serviceMutation.js";

const registration: ServiceRegistration = {
  name: "notes-store",
  source: "workers/notes-store",
  title: "Notes Store",
  action: "Manage notes",
  description: "Retained notes",
  notability: "everyday",
  presentation: { domain: "files", verb: "manage" },
  protocols: ["notes.v1"],
  principals: ["user", "code"],
  binding: { declaredFor: ["panels/notes"] },
  transport: { kind: "durable-object", className: "NotesStore", objectKey: "main" },
};
describe("planServiceMutation", () => {
  it("creates matching declarations without mutating its input", () => {
    const config = { services: [], singletonObjects: [] };
    const result = planServiceMutation(config, { ...registration, operation: "create" });
    expect(config).toEqual({ services: [], singletonObjects: [] });
    expect(result.services[0]).toMatchObject({
      protocols: ["notes.v1"],
      authority: { binding: { declaredFor: ["panels/notes"] } },
      durableObject: { className: "NotesStore" },
    });
    expect(result.singletonObjects).toEqual([
      { source: "workers/notes-store", className: "NotesStore", key: "main" },
    ]);
  });
  it.each(["name", "protocol", "singleton"])("rejects a create collision by %s", (collision) => {
    const config = planServiceMutation({}, { ...registration, operation: "create" });
    const candidate = {
      ...registration,
      operation: "create" as const,
      name: collision === "name" ? registration.name : "other",
      protocols: collision === "protocol" ? registration.protocols : ["other.v1"],
      source: collision === "singleton" ? registration.source : "workers/other",
    };
    expect(() => planServiceMutation(config, candidate)).toThrow("already declared");
  });
  it("leaves a shared singleton unchanged on removal", () => {
    const config = planServiceMutation({}, { ...registration, operation: "create" });
    const shared = planServiceMutation(config, {
      ...registration,
      operation: "upsert",
      name: "second",
      protocols: ["second.v1"],
    });
    expect(
      planServiceMutation(shared, {
        operation: "remove",
        name: registration.name,
        removeSingleton: true,
      })
    ).toEqual({ ...shared, diagnostic: "singleton-still-used" });
    expect(
      planServiceMutation(config, {
        operation: "remove",
        name: registration.name,
        removeSingleton: true,
      })
    ).toEqual({ services: [], singletonObjects: [] });
  });
  it("rejects malformed lists rather than discarding declarations", () => {
    expect(() =>
      planServiceMutation({ services: [null] } as never, { ...registration, operation: "upsert" })
    ).toThrow("malformed");
    expect(() =>
      planServiceMutation({ services: {} } as never, { ...registration, operation: "upsert" })
    ).toThrow("arrays");
  });
});

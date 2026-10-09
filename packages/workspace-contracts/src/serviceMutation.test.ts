import { describe, expect, it } from "vitest";
import { planServiceMutation, type ServiceMutationState } from "./serviceMutation.js";

const service = {
  name: "notes-store",
  title: "Notes Store",
  action: "Manage notes",
  description: "Retained notes",
  notability: "everyday" as const,
  presentation: { domain: "files" as const, verb: "manage" as const },
  protocols: ["notes.v1"],
  authority: { principals: ["user", "code"] as ("user" | "code")[], binding: { declaredFor: ["panels/notes"] } },
  durableObject: { className: "NotesStore" },
};
const registration = { source: "workers/notes-store", service, singletonKey: "main" };
const empty = (): ServiceMutationState => ({ services: [], singletonObjects: [], providerServices: [] });

describe("planServiceMutation", () => {
  it("creates strict root selection and provider export without mutating input", () => {
    const state = empty();
    const result = planServiceMutation(state, { ...registration, operation: "upsert" });
    expect(state).toEqual(empty());
    expect(result.services).toEqual([{ source: "workers/notes-store", name: "notes-store" }]);
    expect(result.providerServices).toEqual([service]);
    expect(result.singletonObjects).toEqual([
      { source: "workers/notes-store", className: "NotesStore", key: "main" },
    ]);
  });

  it("replaces one provider export while retaining other exports", () => {
    const other = { ...service, name: "other", protocols: ["other.v1"] };
    const result = planServiceMutation({
      ...empty(),
      services: [{ source: registration.source, name: service.name }],
      providerServices: [service, other],
    }, { ...registration, operation: "upsert", service: { ...service, description: "Updated" } });
    expect(result.services).toEqual([{ source: registration.source, name: service.name }]);
    expect(result.providerServices).toEqual([{ ...service, description: "Updated" }, other]);
  });

  it("does not let connected-app creation overwrite an existing service identity", () => {
    const state = planServiceMutation(empty(), { ...registration, operation: "create" });
    expect(() => planServiceMutation(state, { ...registration, operation: "create" }))
      .toThrow("service name is already declared");
  });

  it("removes root selection and its provider export, preserving a shared singleton", () => {
    const state = planServiceMutation(empty(), { ...registration, operation: "upsert" });
    const shared = planServiceMutation(state, {
      source: registration.source,
      service: { ...service, name: "second", protocols: ["second.v1"] },
      operation: "upsert",
    });
    expect(planServiceMutation(shared, {
      operation: "remove", source: registration.source, name: service.name, removeSingleton: true,
    })).toEqual({ ...shared, diagnostic: "singleton-still-used" });
    expect(planServiceMutation(state, {
      operation: "remove", source: registration.source, name: service.name, removeSingleton: true,
    })).toEqual(empty());
  });

  it("requires the exact provider selected for removal and rejects malformed state", () => {
    const state = planServiceMutation(empty(), { ...registration, operation: "upsert" });
    expect(planServiceMutation(state, { operation: "remove", source: "workers/other", name: service.name })).toMatchObject({ diagnostic: "not-found" });
    expect(() => planServiceMutation({ ...empty(), services: [null] } as never, { ...registration, operation: "upsert" })).toThrow("malformed");
    expect(() => planServiceMutation({ ...empty(), services: {} } as never, { ...registration, operation: "upsert" })).toThrow("arrays");
  });
});

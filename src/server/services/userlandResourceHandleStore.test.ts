import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UserlandResourceHandleStore,
  type IssueUserlandResourceHandleInput,
} from "./userlandResourceHandleStore.js";

const stores: UserlandResourceHandleStore[] = [];

function createStore(): UserlandResourceHandleStore {
  const store = new UserlandResourceHandleStore({
    statePath: mkdtempSync(join(tmpdir(), "vibestudio-resource-handles-")),
  });
  stores.push(store);
  return store;
}

const input: IssueUserlandResourceHandleInput = {
  workspaceId: "workspace-1",
  capability: "userland:extensions/example/read-record#definition-a",
  capabilityDefinitionDigest: "definition-a",
  provider: "extensions/example",
  receiverSource: "extensions/example",
  receiverClass: "ExampleDO",
  receiverObjectKey: "one",
  resourceType: "example-record",
  selector: "record:42",
  presentation: { title: "Record 42", detail: "Prepared by Example" },
};

afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

describe("UserlandResourceHandleStore", () => {
  it("durably binds an unguessable handle without binding it to a provider rebuild", () => {
    const store = createStore();
    const issued = store.issue(input);
    expect(issued.handle).toMatch(/^urh_[A-Za-z0-9_-]{43}$/u);
    expect(store.resolve(issued.handle, input)).toEqual(issued);
  });

  it("accepts only the bounded preparation returned by a declared producer", () => {
    const store = createStore();
    const issued = store.issueFromPreparation(input, {
      __vibestudioOpaqueHandle: 1,
      selector: input.selector,
      presentation: input.presentation,
    });
    expect(store.resolve(issued.handle, input)).toMatchObject({
      selector: input.selector,
      presentation: input.presentation,
    });
    expect(() => store.issueFromPreparation(input, { selector: input.selector })).toThrow(
      /invalid opaque resource preparation/
    );
  });

  it.each([
    ["workspaceId", "workspace-2"],
    ["capability", "userland:extensions/example/other#definition-a"],
    ["capabilityDefinitionDigest", "definition-b"],
    ["provider", "extensions/other"],
    ["receiverSource", "extensions/other"],
    ["receiverClass", "OtherDO"],
    ["receiverObjectKey", "two"],
    ["resourceType", "other-record"],
  ] as const)("fails closed for a mismatched %s", (field, value) => {
    const store = createStore();
    const issued = store.issue(input);
    expect(() => store.resolve(issued.handle, { ...input, [field]: value })).toThrow(
      /not valid for this receiver capability/
    );
  });

  it("invalidates by explicit revocation, definition change, receiver retirement, and teardown", () => {
    const store = createStore();
    const explicit = store.issue(input);
    expect(store.revoke(explicit.handle, "provider migration")).toBe(true);
    expect(() => store.resolve(explicit.handle, input)).toThrow(/revoked/);

    const retainedDefinition = store.issue(input);
    const staleDefinitionInput = {
      ...input,
      capability: "userland:extensions/example/old-record#definition-old",
      capabilityDefinitionDigest: "definition-old",
    };
    const staleDefinition = store.issue(staleDefinitionInput);
    expect(
      store.reconcileProviderDefinitions(
        input.workspaceId,
        input.provider,
        [input.capabilityDefinitionDigest],
        "definition changed"
      )
    ).toBe(1);
    expect(store.resolve(retainedDefinition.handle, input)).toEqual(retainedDefinition);
    expect(() => store.resolve(staleDefinition.handle, staleDefinitionInput)).toThrow(/revoked/);

    const receiver = store.issue(input);
    expect(
      store.revokeReceiver(
        input.workspaceId,
        {
          source: input.receiverSource,
          className: input.receiverClass,
          objectKey: input.receiverObjectKey,
        },
        "service retired"
      )
    ).toBe(2);
    expect(() => store.resolve(receiver.handle, input)).toThrow(/revoked/);
    expect(() => store.resolve(retainedDefinition.handle, input)).toThrow(/revoked/);

    const removedClassInput = {
      ...input,
      receiverClass: "RemovedDO",
      receiverObjectKey: "removed",
    };
    const removedClass = store.issue(removedClassInput);
    expect(
      store.reconcileReceiverClasses(
        input.workspaceId,
        input.receiverSource,
        [input.receiverClass],
        "manifest reconciled"
      )
    ).toBe(1);
    expect(() => store.resolve(removedClass.handle, removedClassInput)).toThrow(/revoked/);

    const removedProviderInput = {
      ...input,
      capability: "userland:extensions/removed/read-record#definition-a",
      provider: "extensions/removed",
      receiverSource: "extensions/removed",
    };
    const removedProvider = store.issue(removedProviderInput);
    expect(
      store.reconcileProviders(input.workspaceId, [input.provider], "providers reconciled")
    ).toBe(1);
    expect(() => store.resolve(removedProvider.handle, removedProviderInput)).toThrow(/revoked/);

    const workspace = store.issue(input);
    expect(store.revokeWorkspace(input.workspaceId, "workspace teardown")).toBe(1);
    expect(() => store.resolve(workspace.handle, input)).toThrow(/revoked/);
  });
});

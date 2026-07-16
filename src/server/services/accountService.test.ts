import { describe, expect, it } from "vitest";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { createAccountService } from "./accountService.js";
import { updateAccountProfile } from "../hostCore/accountProfile.js";
import { accountProfileUpdateSchema } from "@vibestudio/service-schemas/account";

function makeStores() {
  const identityDb = new IdentityDb({ path: ":memory:", readOnly: false });
  const userStore = new UserStore(identityDb);
  const root = userStore.createRoot({ handle: "werg", displayName: "Werg" });
  const member = userStore.inviteUser({
    handle: "mara",
    displayName: "Mara",
    role: "member",
    createdBy: root.id,
  });
  return { identityDb, userStore, root, member };
}

function createService(
  stores: Pick<ReturnType<typeof makeStores>, "identityDb" | "userStore">,
  members: string[] = []
) {
  const memberIds = new Set(members);
  return createAccountService({
    identityDb: stores.identityDb,
    isWorkspaceMember: (userId) => memberIds.has(userId),
    listWorkspaceMemberUserIds: () => [...memberIds],
  });
}

function ctxFor(userId: string | undefined): ServiceContext {
  return {
    caller: {
      runtime: { id: "panel:test", kind: "panel" },
      ...(userId ? { subject: { userId, handle: "irrelevant" } } : {}),
    },
  };
}

describe("accountService", () => {
  it("getProfile defaults to the caller's own subject and projects live fields", async () => {
    const { identityDb, userStore, member } = makeStores();
    const service = createService({ identityDb, userStore }, [member.id]);

    const profile = await service.handler(ctxFor(member.id), "getProfile", []);
    expect(profile).toMatchObject({
      userId: member.id,
      handle: "mara",
      displayName: "Mara",
      role: "member",
    });
  });

  it("resolveProfiles batch-resolves and omits unknown ids", async () => {
    const { identityDb, userStore, root, member } = makeStores();
    const service = createService({ identityDb, userStore }, [root.id, member.id]);

    const profiles = (await service.handler(ctxFor(root.id), "resolveProfiles", [
      [root.id, member.id, "usr_unknown"],
    ])) as Record<string, { handle: string }>;
    expect(Object.keys(profiles).sort()).toEqual([member.id, root.id].sort());
    expect(profiles[member.id]?.handle).toBe("mara");
  });

  it("validates handle renames against the regex + reserved set", () => {
    const { userStore, member } = makeStores();
    expect(() =>
      updateAccountProfile({ userStore }, { userId: member.id, handle: "9bad" })
    ).toThrow(/must match/);
    expect(() =>
      updateAccountProfile({ userStore }, { userId: member.id, handle: "grep" })
    ).toThrow(/reserved/);
    expect(() =>
      updateAccountProfile({ userStore }, { userId: member.id, handle: "werg" })
    ).toThrow(/taken/);
    const renamed = updateAccountProfile({ userStore }, { userId: member.id, handle: "mara-s" });
    expect(renamed.handle).toBe("mara-s");
  });

  it("enforces reserved names and uniqueness without case ambiguity", () => {
    const { userStore, root, member } = makeStores();
    expect(() =>
      userStore.inviteUser({
        handle: "GREP",
        displayName: "Reserved",
        role: "member",
        createdBy: root.id,
      })
    ).toThrow(/reserved/);
    expect(() =>
      userStore.inviteUser({
        handle: "MARA",
        displayName: "Duplicate",
        role: "member",
        createdBy: root.id,
      })
    ).toThrow(/taken/);
    expect(userStore.getByHandle("MARA")?.id).toBe(member.id);
    expect(userStore.updateProfile(member.id, { handle: "MARA" }).handle).toBe("MARA");
  });

  it("does not partially apply profile fields when a handle claim fails", () => {
    const { userStore, member } = makeStores();
    expect(() =>
      updateAccountProfile(
        { userStore },
        {
          userId: member.id,
          handle: "werg",
          displayName: "Must not persist",
          color: "#123456",
        }
      )
    ).toThrow(/taken/);

    expect(userStore.getUser(member.id)).toMatchObject({
      handle: "mara",
      displayName: "Mara",
    });
    expect(userStore.getUser(member.id)?.color).toBeUndefined();
  });

  it("accepts only valid CSS hex color lengths and rejects unknown patch fields", () => {
    const { userStore, member } = makeStores();
    for (const color of ["#1", "#12", "#12345", "#1234567", "#123456789"]) {
      expect(() => updateAccountProfile({ userStore }, { userId: member.id, color })).toThrow(
        /hex tint/
      );
    }
    for (const color of ["#abc", "#abcd", "#abcdef", "#abcdef12"]) {
      expect(updateAccountProfile({ userStore }, { userId: member.id, color }).color).toBe(color);
    }

    expect(
      accountProfileUpdateSchema.safeParse({ displayName: "Mara", legacy: true }).success
    ).toBe(false);
  });

  it("rejects non-data: and oversized avatars", () => {
    const { userStore, member } = makeStores();
    expect(() =>
      updateAccountProfile(
        { userStore },
        { userId: member.id, avatar: "https://example.com/a.png" }
      )
    ).toThrow(/base64 PNG/);
    expect(() =>
      updateAccountProfile(
        { userStore },
        { userId: member.id, avatar: "data:image/svg+xml;base64,PHN2Zy8+" }
      )
    ).toThrow(/base64 PNG/);
  });

  it("answers membership only for the host-bound workspace predicate", async () => {
    const stores = makeStores();
    const service = createService(stores, [stores.member.id]);

    await expect(
      service.handler(ctxFor(stores.root.id), "isMember", [stores.member.id])
    ).resolves.toBe(true);
    await expect(
      service.handler(ctxFor(stores.root.id), "isMember", [stores.root.id])
    ).resolves.toBe(false);
  });

  it("lists the bound workspace's live profiles without duplicates or unknown ids", async () => {
    const stores = makeStores();
    const service = createAccountService({
      identityDb: stores.identityDb,
      isWorkspaceMember: () => true,
      listWorkspaceMemberUserIds: () => [
        stores.root.id,
        stores.member.id,
        stores.member.id,
        "usr_unknown",
      ],
    });

    await expect(
      service.handler(ctxFor(stores.member.id), "listWorkspaceMembers", [])
    ).resolves.toEqual([
      expect.objectContaining({ userId: stores.root.id, handle: "werg" }),
      expect.objectContaining({ userId: stores.member.id, handle: "mara" }),
    ]);
  });
});

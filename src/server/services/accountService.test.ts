import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { IdentityDb } from "@vibestudio/shared/users/identityDb";
import { UserStore } from "@vibestudio/shared/users/userStore";
import { createAccountService, updateAccountProfile } from "./accountService.js";

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
    writeProfile: async (_actor, input) =>
      updateAccountProfile({ userStore: stores.userStore }, input),
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

const TINY_AVATAR = "data:image/png;base64,iVBORw0KGgo=";

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

  it("updateProfile patches self, clears via null, and re-resolves live", async () => {
    const { identityDb, userStore, member } = makeStores();
    const service = createService({ identityDb, userStore }, [member.id]);

    const updated = await service.handler(ctxFor(member.id), "updateProfile", [
      { displayName: "Mara S.", color: "#4a90d9", avatar: TINY_AVATAR },
    ]);
    expect(updated).toMatchObject({
      handle: "mara",
      displayName: "Mara S.",
      color: "#4a90d9",
      avatar: TINY_AVATAR,
    });

    // Live projection: the next read sees the write with no other plumbing.
    const readBack = await service.handler(ctxFor(member.id), "getProfile", []);
    expect(readBack).toMatchObject({ displayName: "Mara S." });

    const cleared = (await service.handler(ctxFor(member.id), "updateProfile", [
      { color: null },
    ])) as { color?: string };
    expect(cleared.color).toBeUndefined();
  });

  it("only root may update ANOTHER user's profile", async () => {
    const { identityDb, userStore, root, member } = makeStores();
    const second = userStore.inviteUser({
      handle: "kai",
      displayName: "Kai",
      role: "member",
      createdBy: root.id,
    });
    const service = createService({ identityDb, userStore }, [root.id, member.id]);

    await expect(
      service.handler(ctxFor(member.id), "updateProfile", [
        { userId: second.id, displayName: "Hijacked" },
      ])
    ).rejects.toThrow(/Only root/);

    const byRoot = await service.handler(ctxFor(root.id), "updateProfile", [
      { userId: second.id, displayName: "Kai Renamed" },
    ]);
    expect(byRoot).toMatchObject({ userId: second.id, displayName: "Kai Renamed" });
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
    const { identityDb, userStore, member } = makeStores();
    for (const color of ["#1", "#12", "#12345", "#1234567", "#123456789"]) {
      expect(() => updateAccountProfile({ userStore }, { userId: member.id, color })).toThrow(
        /hex tint/
      );
    }
    for (const color of ["#abc", "#abcd", "#abcdef", "#abcdef12"]) {
      expect(updateAccountProfile({ userStore }, { userId: member.id, color }).color).toBe(color);
    }

    const service = createService({ identityDb, userStore }, [member.id]);
    expect(
      service.methods["updateProfile"]?.args.safeParse([{ displayName: "Mara", legacy: true }])
        .success
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

  it("delegates updateProfile through the required hub writer", async () => {
    const { identityDb, userStore, member } = makeStores();
    const writeProfile = vi.fn(async (_actor, input) => updateAccountProfile({ userStore }, input));
    const service = createAccountService({
      identityDb,
      isWorkspaceMember: (userId) => userId === member.id,
      listWorkspaceMemberUserIds: () => [member.id],
      writeProfile,
    });

    await expect(
      service.handler(ctxFor(member.id), "updateProfile", [{ displayName: "Updated" }])
    ).resolves.toMatchObject({ displayName: "Updated" });
    expect(writeProfile).toHaveBeenCalledWith(
      { userId: member.id, handle: "irrelevant" },
      { userId: member.id, displayName: "Updated" }
    );
  });

  it("requires a subject for updateProfile (bootstrap principals have none)", async () => {
    const { identityDb, userStore } = makeStores();
    const service = createService({ identityDb, userStore });
    await expect(
      service.handler(ctxFor(undefined), "updateProfile", [{ displayName: "X" }])
    ).rejects.toThrow(/account subject/);
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
      writeProfile: async (_actor, input) =>
        updateAccountProfile({ userStore: stores.userStore }, input),
    });

    await expect(
      service.handler(ctxFor(stores.member.id), "listWorkspaceMembers", [])
    ).resolves.toEqual([
      expect.objectContaining({ userId: stores.root.id, handle: "werg" }),
      expect.objectContaining({ userId: stores.member.id, handle: "mara" }),
    ]);
  });
});

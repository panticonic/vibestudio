import { MobileAccountProfileClient } from "./accountProfileClient";

const profile = {
  userId: "usr_ada",
  handle: "ada",
  displayName: "Ada Lovelace",
  role: "member" as const,
  color: "#123abc",
};

function createClient() {
  const transport = { call: jest.fn<Promise<unknown>, [string, string, unknown[]]>() };
  return { transport, client: new MobileAccountProfileClient(transport) };
}

describe("MobileAccountProfileClient", () => {
  it("uses the exact updateProfile RPC and refreshes its live account cache", async () => {
    const { client, transport } = createClient();
    transport.call.mockResolvedValueOnce(profile);
    await expect(client.refresh()).resolves.toEqual(profile);
    expect(transport.call).toHaveBeenLastCalledWith("main", "account.getProfile", []);

    const update = { displayName: "Ada Byron", handle: "ada-byron", color: "#abcd" };
    const updated = { ...profile, ...update };
    transport.call.mockResolvedValueOnce(updated);

    await expect(client.update(update)).resolves.toEqual(updated);
    expect(transport.call).toHaveBeenLastCalledWith("main", "hubControl.updateProfile", [update]);
    expect(client.current).toEqual(updated);
  });

  it("propagates server validation failures and preserves the last valid profile", async () => {
    const { client, transport } = createClient();
    transport.call.mockResolvedValueOnce(profile);
    await client.refresh();
    transport.call.mockRejectedValueOnce(new Error('Handle "taken" is already taken'));

    await expect(client.update({ handle: "taken" })).rejects.toThrow(
      'Handle "taken" is already taken'
    );
    expect(client.current).toEqual(profile);
  });
});

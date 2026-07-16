import {
  accountMethods,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/service-schemas/account";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";

export type MobileAccountProfile = AccountProfile;
export type MobileAccountProfileUpdate = AccountProfileUpdate;

interface AccountProfileTransport {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

export class MobileAccountProfileClient {
  private profile: MobileAccountProfile | null = null;
  private readonly account;
  private readonly hubControl;

  constructor(transport: AccountProfileTransport) {
    this.account = createTypedServiceClient("account", accountMethods, (service, method, args) =>
      transport.call("main", `${service}.${method}`, args)
    );
    this.hubControl = createTypedServiceClient(
      "hubControl",
      hubControlMethods,
      (service, method, args) => transport.call("main", `${service}.${method}`, args)
    );
  }

  get current(): MobileAccountProfile | null {
    return this.profile;
  }

  async refresh(): Promise<MobileAccountProfile> {
    const profile = await this.account.getProfile();
    if (!profile) {
      throw new Error("The connected session does not have an active workspace account.");
    }
    this.profile = profile;
    return profile;
  }

  async update(input: MobileAccountProfileUpdate): Promise<MobileAccountProfile> {
    const profile = await this.hubControl.updateProfile(input);
    this.profile = profile;
    return profile;
  }

  resolve(userIds: readonly string[]): Promise<Record<string, MobileAccountProfile>> {
    return this.account.resolveProfiles([...userIds]);
  }
}

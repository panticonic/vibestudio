import { z } from "zod";
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";
import { browserDataMethods } from "./browserData.js";

const directTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "shellBrowserPrivacy.manager",
  rationale:
    "The authenticated human shell manages its own workspace browser vault through a narrow typed surface.",
};
const userAuthority = {
  principals: ["user"],
} satisfies NonNullable<MethodSchema["authority"]>;

function direct<T extends MethodSchema>(receiver: T) {
  return {
    description: receiver.description,
    args: receiver.args,
    returns: receiver.returns,
    tier: directTier,
    authority: userAuthority,
    access: receiver.access,
    agentFacing: false,
  };
}

export const shellBrowserPrivacyMethods = defineServiceMethods({
  listPasswordSummariesPage: direct(browserDataMethods.listPasswordSummariesPage),
  getNeverSaveOriginsPage: direct(browserDataMethods.getNeverSaveOriginsPage),
  listFormFillValuesPage: direct(browserDataMethods.listFormFillValuesPage),
  listCookieOriginsPage: direct(browserDataMethods.listCookieOriginsPage),
  deletePassword: direct(browserDataMethods.deletePassword),
  removeNeverSave: direct(browserDataMethods.removeNeverSave),
  addFormFillValue: direct(browserDataMethods.addFormFillValue),
  updateFormFillValue: direct(browserDataMethods.updateFormFillValue),
  deleteFormFillValue: direct(browserDataMethods.deleteFormFillValue),
  clearFormFillValues: direct(browserDataMethods.clearFormFillValues),
  clearCookiesForOrigin: direct(browserDataMethods.clearCookiesForOrigin),
  clearAllCookies: direct(browserDataMethods.clearAllCookies),
  endBrowserSession: direct(browserDataMethods.endBrowserSession),
  getCookieSiteSummary: direct(browserDataMethods.getCookieSiteSummary),
  getPasswordCountForSite: {
    description: "Count saved passwords for one exact site without returning password material.",
    args: z.tuple([z.string().url()]),
    returns: z
      .object({ origin: z.string().url(), passwordCount: z.number().int().nonnegative() })
      .strict(),
    tier: directTier,
    authority: { principals: ["user"] },
    access: { sensitivity: "read" as const },
    agentFacing: false,
  },
});

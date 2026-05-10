import { atom } from "jotai";

export const approvalDeepLinkAtom = atom<string | null>(null);

export const consumeApprovalDeepLinkAtom = atom(null, (_get, set) => {
  set(approvalDeepLinkAtom, null);
});

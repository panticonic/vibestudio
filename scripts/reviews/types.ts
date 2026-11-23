export type PublicClaimAssessment = {
  goal: string;
  answer: string;
  citations: { url: string; quote: string }[];
  sources: { url: string; requested?: string; title: string; retrieved?: string; published?: string | null; sha256: string; text: string }[];
  sourceScope: string[] | null;
};
export type PublicClaimVerdict = {
  supported: boolean;
  fulfillsGoal: boolean;
  needsReview: boolean;
  rationale: string;
};

export type PublicClaimAssessment = {
  goal: string;
  answer: string;
  citations: { url: string; quote: string }[];
  sources: { url: string; requested?: string; title: string; retrieved?: string; published?: string | null; sha256: string; text: string }[];
  sourceScope: string[] | null;
  documentEdits?: {path:string;originalText:string;originalSha256:string;retainedText:string;retainedSha256:string;
    editableOriginal:string;actualReplacement:string;protectedPrefix:string;protectedSuffix:string;concurrentAddition:string;
    authority:{path:string;text:string;sha256:string}}[];
};
export type PublicClaimVerdict = {
  supported: boolean;
  fulfillsGoal: boolean;
  needsReview: boolean;
  rationale: string;
};

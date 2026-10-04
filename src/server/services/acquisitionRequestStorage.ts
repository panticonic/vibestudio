import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { JsonValue } from "@vibestudio/shared/wireValues";
import { JsonValueSchema } from "@vibestudio/shared/wireValues";
import type { AcquisitionRequestInput } from "./acquisitionCoordinator.js";

type InstallReview = NonNullable<AuthorityChallengePresentation["installReview"]>;
type ReviewCollections = Pick<
  InstallReview,
  | "previousRequests"
  | "previouslyCleared"
  | "origins"
  | "identityKeys"
  | "sections"
  | "originallyInstalledFrom"
>;
type StoredReview = Omit<InstallReview, keyof ReviewCollections> & {
  [K in keyof ReviewCollections]: NonNullable<ReviewCollections[K]> extends ReadonlyMap<
    infer Key,
    infer Value
  >
    ? Array<[Key, Value extends ReadonlySet<infer Member> ? Member[] : Value]>
    : never;
};
type StoredPresentation = Omit<AuthorityChallengePresentation, "signal" | "installReview"> & {
  installReview?: StoredReview;
};
type StoredInput = Omit<AcquisitionRequestInput, "presentation"> & {
  presentation?: StoredPresentation;
};

/** Host-sealed data only. Abort signals are rebound by the live lifecycle owner. */
export function storeAcquisitionInputs(inputs: readonly AcquisitionRequestInput[]): JsonValue {
  const stored: StoredInput[] = inputs.map(({ presentation, ...input }) => {
    if (!presentation) return input;
    const { signal: _signal, installReview, ...data } = presentation;
    if (!installReview) return { ...input, presentation: data };
    const {
      previousRequests,
      previouslyCleared,
      origins,
      identityKeys,
      sections,
      originallyInstalledFrom,
      ...review
    } = installReview;
    return {
      ...input,
      presentation: {
        ...data,
        installReview: {
          ...review,
          ...(previousRequests ? { previousRequests: [...previousRequests] } : {}),
          ...(previouslyCleared
            ? { previouslyCleared: [...previouslyCleared].map(([key, rows]) => [key, [...rows]]) }
            : {}),
          ...(origins ? { origins: [...origins] } : {}),
          ...(identityKeys ? { identityKeys: [...identityKeys] } : {}),
          ...(sections ? { sections: [...sections] } : {}),
          ...(originallyInstalledFrom
            ? { originallyInstalledFrom: [...originallyInstalledFrom] }
            : {}),
        },
      },
    };
  });
  return acquisitionJson({ format: 1, inputs: stored });
}

export function restoreAcquisitionInputs(value: JsonValue): readonly AcquisitionRequestInput[] {
  JsonValueSchema.parse(value);
  const stored = value as unknown as { format: number; inputs: StoredInput[] };
  if (stored?.format !== 1 || !Array.isArray(stored.inputs) || stored.inputs.length === 0)
    throw new Error("Unsupported or empty stored acquisition request");
  return stored.inputs.map(({ presentation, ...input }) => {
    if (!presentation) return input;
    const { installReview, ...data } = presentation;
    if (!installReview) return { ...input, presentation: data };
    const {
      previousRequests,
      previouslyCleared,
      origins,
      identityKeys,
      sections,
      originallyInstalledFrom,
      ...review
    } = installReview;
    return {
      ...input,
      presentation: {
        ...presentation,
        installReview: {
          ...review,
          ...(previousRequests ? { previousRequests: new Map(previousRequests) } : {}),
          ...(previouslyCleared
            ? {
                previouslyCleared: new Map(
                  previouslyCleared.map(([key, rows]) => [key, new Set(rows)])
                ),
              }
            : {}),
          ...(origins ? { origins: new Map(origins) } : {}),
          ...(identityKeys ? { identityKeys: new Map(identityKeys) } : {}),
          ...(sections ? { sections: new Map(sections) } : {}),
          ...(originallyInstalledFrom
            ? { originallyInstalledFrom: new Map(originallyInstalledFrom) }
            : {}),
        },
      },
    };
  });
}

/** Detach optional plain data without silently discarding Maps, handles or non-JSON values. */
export function acquisitionJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || ancestors.has(value))
    throw new Error("Acquisition facts must be finite acyclic JSON data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => acquisitionJson(item, ancestors));
    if (
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length !== 0
    )
      throw new Error("Acquisition facts contain a live handle or unsupported collection");
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, acquisitionJson(item, ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

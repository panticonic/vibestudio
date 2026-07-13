/**
 * One paging contract for semantic channel reads and compact inspection.
 *
 * The discriminated window makes invalid cursor combinations impossible:
 * callers choose the current tail, the page after one sequence, or the page
 * before one sequence. Both hydrated and compact projections return the same
 * `items + pageInfo` shape.
 */

import { z } from "zod";

export const DEFAULT_CHANNEL_ENVELOPE_PAGE_LIMIT = 50;
export const MAX_CHANNEL_ENVELOPE_PAGE_LIMIT = 500;

export const ChannelEnvelopeWindowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tail") }).strict(),
  z
    .object({
      kind: z.literal("after"),
      seq: z.number().int().nonnegative(),
      /** Inclusive high-water mark for stable forward continuation pages. */
      throughSeq: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("before"), seq: z.number().int().nonnegative() }).strict(),
]);
export type ChannelEnvelopeWindow = z.infer<typeof ChannelEnvelopeWindowSchema>;

export const ChannelEnvelopePageRequestSchema = z
  .object({
    channelId: z.string().trim().min(1),
    window: ChannelEnvelopeWindowSchema.optional(),
    limit: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CHANNEL_ENVELOPE_PAGE_LIMIT, {
        message: `limit must not exceed ${MAX_CHANNEL_ENVELOPE_PAGE_LIMIT}`,
      })
      .nullish(),
    payloadKind: z.string().trim().min(1).nullish(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.window?.kind === "after" &&
      request.window.throughSeq !== undefined &&
      request.window.throughSeq < request.window.seq
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window", "throughSeq"],
        message: "after window throughSeq must be greater than or equal to seq",
      });
    }
  });
export type ChannelEnvelopePageRequest = z.infer<typeof ChannelEnvelopePageRequestSchema>;

export interface ChannelEnvelopeSequenceStats {
  totalCount: number;
  firstSeq?: number;
  lastSeq?: number;
}

export interface NormalizedChannelEnvelopePageRequest {
  channelId: string;
  window: ChannelEnvelopeWindow;
  limit: number;
  payloadKind?: string;
}

export const ChannelEnvelopePageInfoSchema = z
  .object({
    request: z
      .object({
        window: ChannelEnvelopeWindowSchema,
        limit: z.number().int().nonnegative().max(MAX_CHANNEL_ENVELOPE_PAGE_LIMIT),
        payloadKind: z.string().min(1).optional(),
      })
      .strict(),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative().optional(),
    lastSeq: z.number().int().nonnegative().optional(),
    /** Stable forward-read high-water mark captured by this page. */
    snapshotLastSeq: z.number().int().nonnegative().optional(),
    returnedFromSeq: z.number().int().nonnegative().optional(),
    returnedToSeq: z.number().int().nonnegative().optional(),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean(),
  })
  .strict();
export type ChannelEnvelopePageInfo = z.infer<typeof ChannelEnvelopePageInfoSchema>;

export interface ChannelEnvelopePage<T> {
  items: T[];
  pageInfo: ChannelEnvelopePageInfo;
}

export function channelEnvelopePageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      pageInfo: ChannelEnvelopePageInfoSchema,
    })
    .strict();
}

export interface ChannelEnvelopePageCollectionOptions {
  /** Total number of items to collect, or every item remaining in the window direction. */
  maximumItems: number | "all";
  /** Size of each bounded RPC page. Defaults to the service maximum. */
  pageSize?: number;
}

/** Build projection-independent paging metadata, including empty pages. */
export function channelEnvelopePageInfo(
  request: NormalizedChannelEnvelopePageRequest,
  stats: ChannelEnvelopeSequenceStats,
  returnedSeqs: readonly number[]
): ChannelEnvelopePageInfo {
  const returnedFromSeq = returnedSeqs[0];
  const returnedToSeq = returnedSeqs[returnedSeqs.length - 1];
  const snapshotLastSeq =
    request.window.kind === "after" && request.window.throughSeq !== undefined
      ? stats.lastSeq === undefined
        ? request.window.throughSeq
        : Math.min(stats.lastSeq, request.window.throughSeq)
      : stats.lastSeq;
  let hasMoreBefore: boolean;
  let hasMoreAfter: boolean;

  if (returnedFromSeq !== undefined && returnedToSeq !== undefined) {
    hasMoreBefore = stats.firstSeq !== undefined && stats.firstSeq < returnedFromSeq;
    hasMoreAfter = snapshotLastSeq !== undefined && snapshotLastSeq > returnedToSeq;
  } else if (request.window.kind === "tail") {
    hasMoreBefore = stats.totalCount > 0;
    hasMoreAfter = false;
  } else if (request.window.kind === "after") {
    hasMoreBefore = stats.firstSeq !== undefined && stats.firstSeq <= request.window.seq;
    hasMoreAfter = snapshotLastSeq !== undefined && snapshotLastSeq > request.window.seq;
  } else {
    hasMoreBefore = stats.firstSeq !== undefined && stats.firstSeq < request.window.seq;
    hasMoreAfter = stats.lastSeq !== undefined && stats.lastSeq >= request.window.seq;
  }

  return {
    request: {
      window: request.window,
      limit: request.limit,
      ...(request.payloadKind ? { payloadKind: request.payloadKind } : {}),
    },
    returnedCount: returnedSeqs.length,
    totalCount: stats.totalCount,
    ...(stats.firstSeq !== undefined ? { firstSeq: stats.firstSeq } : {}),
    ...(stats.lastSeq !== undefined ? { lastSeq: stats.lastSeq } : {}),
    ...(snapshotLastSeq !== undefined ? { snapshotLastSeq } : {}),
    ...(returnedFromSeq !== undefined ? { returnedFromSeq } : {}),
    ...(returnedToSeq !== undefined ? { returnedToSeq } : {}),
    hasMoreBefore,
    hasMoreAfter,
  };
}

export function normalizeChannelEnvelopePageRequest(
  input: ChannelEnvelopePageRequest
): NormalizedChannelEnvelopePageRequest {
  const parsed = ChannelEnvelopePageRequestSchema.safeParse(input);
  if (!parsed.success) throwPagingRequestError(parsed.error);
  const channelId = parsed.data.channelId;
  const window = parsed.data.window ?? { kind: "tail" as const };
  const rawLimit = parsed.data.limit ?? DEFAULT_CHANNEL_ENVELOPE_PAGE_LIMIT;
  const payloadKind = parsed.data.payloadKind ?? undefined;
  return {
    channelId,
    window,
    limit: rawLimit,
    ...(payloadKind ? { payloadKind } : {}),
  };
}

/**
 * Follow the cursor metadata returned by bounded channel-envelope pages.
 *
 * Pages are returned in ascending sequence order even when collecting a tail
 * or `before` window (whose RPC reads naturally walk backwards). Cursor
 * progress is checked on every step; a store that claims more data without
 * returning a usable cursor fails loudly instead of looping or truncating.
 */
export async function collectChannelEnvelopePages<T>(
  input: Omit<ChannelEnvelopePageRequest, "limit">,
  options: ChannelEnvelopePageCollectionOptions,
  readPage: (request: ChannelEnvelopePageRequest) => Promise<ChannelEnvelopePage<T>>
): Promise<Array<ChannelEnvelopePage<T>>> {
  const maximumItems = options.maximumItems;
  if (maximumItems !== "all" && (!Number.isInteger(maximumItems) || maximumItems < 0)) {
    throw new RangeError("maximumItems must be a non-negative integer or 'all'");
  }
  const pageSize = options.pageSize ?? MAX_CHANNEL_ENVELOPE_PAGE_LIMIT;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_CHANNEL_ENVELOPE_PAGE_LIMIT) {
    throw new RangeError(
      `pageSize must be an integer between 1 and ${MAX_CHANNEL_ENVELOPE_PAGE_LIMIT}`
    );
  }

  const initialWindow = input.window ?? { kind: "tail" as const };
  const backwards = initialWindow.kind !== "after";
  let window: ChannelEnvelopeWindow = initialWindow;
  let forwardThroughSeq = initialWindow.kind === "after" ? initialWindow.throughSeq : undefined;
  let remaining = maximumItems;
  const pages: Array<ChannelEnvelopePage<T>> = [];

  if (remaining === 0) {
    pages.push(await readPage({ ...input, window, limit: 0 }));
    return pages;
  }

  while (remaining === "all" || remaining > 0) {
    const limit = remaining === "all" ? pageSize : Math.min(pageSize, remaining);
    const pageRequest = { ...input, window, limit };
    const rawPage = await readPage(pageRequest);
    const page: ChannelEnvelopePage<T> = {
      items: rawPage.items,
      pageInfo: ChannelEnvelopePageInfoSchema.parse(rawPage.pageInfo),
    };
    assertChannelEnvelopePageRequestEcho(pageRequest, page.pageInfo);
    if (!backwards && forwardThroughSeq === undefined) {
      forwardThroughSeq = page.pageInfo.snapshotLastSeq;
    }
    if (page.pageInfo.returnedCount !== page.items.length) {
      throw new Error(
        `channel envelope page returnedCount mismatch: metadata=${page.pageInfo.returnedCount}, items=${page.items.length}`
      );
    }
    if (backwards) pages.unshift(page);
    else pages.push(page);

    if (remaining !== "all") remaining -= page.items.length;
    const hasMore = backwards ? page.pageInfo.hasMoreBefore : page.pageInfo.hasMoreAfter;
    if (!hasMore || (remaining !== "all" && remaining === 0)) break;

    if (!backwards && forwardThroughSeq === undefined) {
      throw new Error(
        "channel envelope forward page claims more data without a snapshotLastSeq watermark"
      );
    }

    const cursor = backwards ? page.pageInfo.returnedFromSeq : page.pageInfo.returnedToSeq;
    if (cursor === undefined || page.items.length === 0) {
      throw new Error(
        `channel envelope paging made no ${backwards ? "backward" : "forward"} progress`
      );
    }
    if (backwards && window.kind === "before" && cursor >= window.seq) {
      throw new Error(
        `channel envelope paging did not move backward: cursor ${cursor} is not before ${window.seq}`
      );
    }
    if (!backwards && window.kind === "after" && cursor <= window.seq) {
      throw new Error(
        `channel envelope paging did not move forward: cursor ${cursor} is not after ${window.seq}`
      );
    }
    if (!backwards && forwardThroughSeq !== undefined && cursor > forwardThroughSeq) {
      throw new Error(
        `channel envelope paging crossed its snapshot watermark: cursor ${cursor} exceeds ${forwardThroughSeq}`
      );
    }
    window = backwards
      ? { kind: "before", seq: cursor }
      : {
          kind: "after",
          seq: cursor,
          ...(forwardThroughSeq !== undefined ? { throughSeq: forwardThroughSeq } : {}),
        };
  }

  return pages;
}

function assertChannelEnvelopePageRequestEcho(
  input: ChannelEnvelopePageRequest,
  pageInfo: ChannelEnvelopePageInfo
): void {
  const expected = normalizeChannelEnvelopePageRequest(input);
  const actual = pageInfo.request;
  if (
    !sameChannelEnvelopeWindow(actual.window, expected.window) ||
    actual.limit !== expected.limit ||
    actual.payloadKind !== expected.payloadKind
  ) {
    throw new Error("channel envelope page metadata does not match its request");
  }
}

function sameChannelEnvelopeWindow(
  actual: ChannelEnvelopeWindow,
  expected: ChannelEnvelopeWindow
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "tail") return true;
  if (actual.kind === "before") {
    return expected.kind === "before" && actual.seq === expected.seq;
  }
  return (
    expected.kind === "after" &&
    actual.seq === expected.seq &&
    actual.throughSeq === expected.throughSeq
  );
}

function throwPagingRequestError(error: z.ZodError): never {
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : []
  );
  if (unknown.length > 0) {
    throw new TypeError(`unknown channel envelope page field(s): ${unknown.join(", ")}`);
  }
  throw error;
}

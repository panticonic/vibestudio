import { describe, expect, it } from "vitest";
import {
  channelEnvelopePageInfo,
  collectChannelEnvelopePages,
  normalizeChannelEnvelopePageRequest,
} from "./channelEnvelopePaging.js";

describe("normalizeChannelEnvelopePageRequest", () => {
  it("defaults to a bounded tail window", () => {
    expect(normalizeChannelEnvelopePageRequest({ channelId: " channel-1 " })).toEqual({
      channelId: "channel-1",
      window: { kind: "tail" },
      limit: 50,
    });
  });

  it("accepts one valid cursor shape", () => {
    expect(
      normalizeChannelEnvelopePageRequest({
        channelId: "channel-1",
        window: { kind: "after", seq: 7 },
        limit: 25,
        payloadKind: " custom.kind ",
      })
    ).toEqual({
      channelId: "channel-1",
      window: { kind: "after", seq: 7 },
      limit: 25,
      payloadKind: "custom.kind",
    });
  });

  it("rejects oversized pages instead of silently truncating the request", () => {
    expect(() =>
      normalizeChannelEnvelopePageRequest({ channelId: "channel-1", limit: 1_000 })
    ).toThrow("limit must not exceed 500");
  });

  it("rejects misspelled and incompatible legacy fields instead of ignoring them", () => {
    expect(() =>
      normalizeChannelEnvelopePageRequest({
        channelId: "channel-1",
        mode: "after",
        sinceSeq: 7,
      } as never)
    ).toThrow(/unknown.*mode.*sinceSeq/i);
    expect(() =>
      normalizeChannelEnvelopePageRequest({
        channelId: "channel-1",
        window: { kind: "tail", seq: 7 },
      } as never)
    ).toThrow(/unknown.*seq/i);
  });

  it("reports both directions consistently for populated and empty pages", () => {
    const after = normalizeChannelEnvelopePageRequest({
      channelId: "channel-1",
      window: { kind: "after", seq: 5 },
      limit: 2,
    });
    expect(
      channelEnvelopePageInfo(after, { totalCount: 10, firstSeq: 1, lastSeq: 10 }, [6, 7])
    ).toEqual({
      request: { window: { kind: "after", seq: 5 }, limit: 2 },
      returnedCount: 2,
      totalCount: 10,
      firstSeq: 1,
      lastSeq: 10,
      snapshotLastSeq: 10,
      returnedFromSeq: 6,
      returnedToSeq: 7,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(
      channelEnvelopePageInfo(after, { totalCount: 10, firstSeq: 1, lastSeq: 10 }, [])
    ).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    const tail = normalizeChannelEnvelopePageRequest({ channelId: "channel-1", limit: 0 });
    expect(
      channelEnvelopePageInfo(tail, { totalCount: 1, firstSeq: 4, lastSeq: 4 }, [])
    ).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
  });

  it("rejects an inverted stable forward window", () => {
    expect(() =>
      normalizeChannelEnvelopePageRequest({
        channelId: "channel-1",
        window: { kind: "after", seq: 10, throughSeq: 9 },
      })
    ).toThrow("throughSeq must be greater than or equal to seq");
  });
});

describe("collectChannelEnvelopePages", () => {
  it("collects a forward window without hiding page boundaries", async () => {
    const all = [1, 2, 3, 4, 5];
    const readPage = async (input: Parameters<typeof normalizeChannelEnvelopePageRequest>[0]) => {
      const request = normalizeChannelEnvelopePageRequest(input);
      const after = request.window.kind === "after" ? request.window.seq : 0;
      const seqs = all.filter((seq) => seq > after).slice(0, request.limit);
      return {
        items: seqs,
        pageInfo: channelEnvelopePageInfo(
          request,
          { totalCount: all.length, firstSeq: 1, lastSeq: 5 },
          seqs
        ),
      };
    };

    const pages = await collectChannelEnvelopePages(
      { channelId: "channel-1", window: { kind: "after", seq: 0 } },
      { maximumItems: "all", pageSize: 2 },
      readPage
    );

    expect(pages.map((page) => page.items)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pages.map((page) => page.pageInfo.request.limit)).toEqual([2, 2, 2]);
    expect(pages.map((page) => page.pageInfo.returnedCount)).toEqual([2, 2, 1]);
  });

  it("returns backward pages in ascending sequence order", async () => {
    const all = [1, 2, 3, 4, 5];
    const readPage = async (input: Parameters<typeof normalizeChannelEnvelopePageRequest>[0]) => {
      const request = normalizeChannelEnvelopePageRequest(input);
      const before = request.window.kind === "before" ? request.window.seq : Infinity;
      const candidates = all.filter((seq) => seq < before);
      const seqs = candidates.slice(Math.max(0, candidates.length - request.limit));
      return {
        items: seqs,
        pageInfo: channelEnvelopePageInfo(
          request,
          { totalCount: all.length, firstSeq: 1, lastSeq: 5 },
          seqs
        ),
      };
    };

    const pages = await collectChannelEnvelopePages(
      { channelId: "channel-1", window: { kind: "tail" } },
      { maximumItems: 4, pageSize: 2 },
      readPage
    );

    expect(pages.flatMap((page) => page.items)).toEqual([2, 3, 4, 5]);
  });

  it("pins forward continuation pages to the first page high-water mark", async () => {
    const all = [1, 2, 3, 4, 5];
    const requests: Array<ReturnType<typeof normalizeChannelEnvelopePageRequest>> = [];
    const readPage = async (input: Parameters<typeof normalizeChannelEnvelopePageRequest>[0]) => {
      const request = normalizeChannelEnvelopePageRequest(input);
      requests.push(request);
      const after = request.window.kind === "after" ? request.window.seq : 0;
      const through =
        request.window.kind === "after" ? (request.window.throughSeq ?? Infinity) : Infinity;
      const returned = all.filter((seq) => seq > after && seq <= through).slice(0, request.limit);
      const page = {
        items: returned,
        pageInfo: channelEnvelopePageInfo(
          request,
          { totalCount: all.length, firstSeq: 1, lastSeq: all[all.length - 1] },
          returned
        ),
      };
      if (requests.length === 1) all.push(6);
      return page;
    };

    const pages = await collectChannelEnvelopePages(
      { channelId: "channel-1", window: { kind: "after", seq: 0 } },
      { maximumItems: "all", pageSize: 2 },
      readPage
    );

    expect(pages.flatMap((page) => page.items)).toEqual([1, 2, 3, 4, 5]);
    expect(requests.slice(1).map((request) => request.window)).toEqual([
      { kind: "after", seq: 2, throughSeq: 5 },
      { kind: "after", seq: 4, throughSeq: 5 },
    ]);
  });

  it("rejects a store that claims more data without advancing", async () => {
    await expect(
      collectChannelEnvelopePages(
        { channelId: "channel-1", window: { kind: "after", seq: 0 } },
        { maximumItems: "all" },
        async (input) => {
          const request = normalizeChannelEnvelopePageRequest(input);
          return {
            items: [],
            pageInfo: {
              ...channelEnvelopePageInfo(request, { totalCount: 1, firstSeq: 1, lastSeq: 1 }, []),
              hasMoreAfter: true,
            },
          };
        }
      )
    ).rejects.toThrow("made no forward progress");
  });

  it("rejects a store that repeats a non-empty cursor", async () => {
    await expect(
      collectChannelEnvelopePages(
        { channelId: "channel-1", window: { kind: "after", seq: 1 } },
        { maximumItems: "all", pageSize: 1 },
        async (input) => {
          const request = normalizeChannelEnvelopePageRequest(input);
          return {
            items: [1],
            pageInfo: {
              ...channelEnvelopePageInfo(request, { totalCount: 2, firstSeq: 1, lastSeq: 2 }, [1]),
              hasMoreAfter: true,
            },
          };
        }
      )
    ).rejects.toThrow("did not move forward");
  });

  it("requires a stable snapshot watermark before continuing forward", async () => {
    await expect(
      collectChannelEnvelopePages(
        { channelId: "channel-1", window: { kind: "after", seq: 0 } },
        { maximumItems: "all", pageSize: 1 },
        async (input) => {
          const request = normalizeChannelEnvelopePageRequest(input);
          const pageInfo = channelEnvelopePageInfo(
            request,
            { totalCount: 2, firstSeq: 1, lastSeq: 2 },
            [1]
          );
          delete pageInfo.snapshotLastSeq;
          return { items: [1], pageInfo };
        }
      )
    ).rejects.toThrow("without a snapshotLastSeq watermark");
  });
});

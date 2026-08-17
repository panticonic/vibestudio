/**
 * dataChannelContract — the executable form of what `RtcDataChannelLike`
 * requires of an adapter.
 *
 * The requirements themselves are documented on the interface (see
 * `webrtcPeer.ts`); this turns them into assertions every adapter must pass, so
 * they hold for *all* adapters rather than for whichever one a bug was last
 * found in. That gap is not hypothetical: a fix making the react-native
 * adapter's buffered level truthful landed on its own, and nothing existed to
 * ask whether the node adapter needed the same treatment.
 *
 * The two properties here are the ones the frame scheduler actually depends on.
 * Both failed in production and both were invisible from the interface alone:
 *
 *  - A level that omits the write that just returned tells the pump there is
 *    room when there is none, and it keeps writing until something else breaks.
 *  - A low-water edge compared strictly makes a threshold of zero — which means
 *    "wait until empty" — unsatisfiable, parking every writer forever.
 *
 * An adapter over a platform that reports the level synchronously and
 * accurately satisfies the first requirement by delegation; one whose platform
 * reports late must count its own sends. `platformReportsSendsSynchronously`
 * says which case the adapter under test is, so the suite asserts the property
 * rather than one particular implementation of it.
 */

export interface DataChannelContractSubject {
  /** The adapter under test, already wired to `platform`. */
  channel: {
    readonly bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    send(data: Uint8Array): void;
    onBufferedAmountLow(handler: () => void): () => void;
  };
  /**
   * Drive the fake platform underneath the adapter: report an absolute buffered
   * level, and fire the platform's own low-water edge.
   */
  platform: {
    reportLevel(bytes: number): void;
    emitLow(): void;
  };
  /**
   * True when the platform's `bufferedAmount` already includes a write the
   * moment `send` returns (libdatachannel does; react-native-webrtc does not).
   * Adapters over a lagging platform must compensate by counting sends.
   */
  platformReportsSendsSynchronously: boolean;
}

export interface DataChannelContractHarness {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
  };
}

/**
 * Assert the `RtcDataChannelLike` contract against one adapter.
 *
 * Takes its test primitives as arguments so the same suite runs under whichever
 * runner owns the adapter's package.
 */
export function describeDataChannelContract(
  harness: DataChannelContractHarness,
  label: string,
  createSubject: () => DataChannelContractSubject
): void {
  const { describe, it, expect } = harness;

  describe(`${label} satisfies the RtcDataChannelLike contract`, () => {
    it("counts a write that just returned as still buffered", () => {
      const subject = createSubject();
      subject.platform.reportLevel(0);
      subject.channel.send(new Uint8Array(16 * 1024));

      if (subject.platformReportsSendsSynchronously) {
        // The platform owns the figure; report what it says, and it has already
        // accounted for the send (or the bytes genuinely left).
        subject.platform.reportLevel(16 * 1024);
        expect(subject.channel.bufferedAmount).toBe(16 * 1024);
      } else {
        // The platform is still reporting the pre-send figure. Publishing that
        // stale zero is the failure this asserts against.
        expect(subject.channel.bufferedAmount).toBeGreaterThan(0);
      }
    });

    it("fires the low-water edge at a threshold of zero", () => {
      // Zero is the mobile bulk channel's "wait until empty". An adapter that
      // forwards a platform's strict `<` comparison can never satisfy it.
      const subject = createSubject();
      subject.channel.bufferedAmountLowThreshold = 0;
      let fired = 0;
      subject.channel.onBufferedAmountLow(() => {
        fired += 1;
      });

      subject.platform.reportLevel(16 * 1024);
      subject.platform.reportLevel(0);
      subject.platform.emitLow();

      expect(fired > 0).toBe(true);
    });

    it("fires the low-water edge at exact equality, not only below it", () => {
      const subject = createSubject();
      subject.channel.bufferedAmountLowThreshold = 1024;
      let fired = 0;
      subject.channel.onBufferedAmountLow(() => {
        fired += 1;
      });

      subject.platform.reportLevel(4096);
      subject.platform.reportLevel(1024); // exactly at the threshold
      subject.platform.emitLow();

      expect(fired > 0).toBe(true);
    });

    it("stops notifying a handler that unsubscribed", () => {
      const subject = createSubject();
      let fired = 0;
      const off = subject.channel.onBufferedAmountLow(() => {
        fired += 1;
      });
      off();

      subject.platform.reportLevel(0);
      subject.platform.emitLow();

      expect(fired).toBe(0);
    });
  });
}

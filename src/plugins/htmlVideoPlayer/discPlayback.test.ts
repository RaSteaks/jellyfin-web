import { describe, expect, it } from 'vitest';
import { DiscAdaptivePolicy, getDiscBufferedAhead, getDiscBufferLimits } from './discPlayback';

describe('Disc buffering and adaptive quality', () => {
    it('keeps startup and recovery reachable with the existing high-bitrate buffer cap', () => {
        const high = getDiscBufferLimits(120_000_000, false, true);
        expect(high.forward).toBeLessThanOrEqual(6);
        expect(high.start).toBeLessThan(high.forward);
        expect(high.resume).toBeLessThan(high.forward);
        const mobile = getDiscBufferLimits(8_000_000, true, false);
        const desktop = getDiscBufferLimits(8_000_000, false, false);
        expect(mobile.forward).toBeLessThan(desktop.forward);
    });

    it('does not count the range beyond a seek hole as playable buffer', () => {
        const ranges = { length: 2, start: (i: number) => [0, 60][i], end: (i: number) => [10, 90][i] };
        expect(getDiscBufferedAhead(ranges, 8)).toBe(2);
        expect(getDiscBufferedAhead(ranges, 30)).toBe(0);
        expect(getDiscBufferedAhead(ranges, 65)).toBe(25);
    });

    it('waits two minutes to raise quality, then backs off a failed upswitch', () => {
        const policy = new DiscAdaptivePolicy([1_000_000, 3_000_000, 6_000_000], 2_000_000);
        expect(policy.cap).toBe(0);
        for (let seconds = 0; seconds < 120; seconds++) {
            expect(policy.update(seconds * 1000, 0, 20_000_000, 50, 60, true)).toBe(0);
        }
        expect(policy.update(120_000, 0, 20_000_000, 50, 60, true)).toBe(1);
        policy.update(121_000, 1, 20_000_000, 50, 60, true);
        expect(policy.stalled(130_000, 1)).toBe(0);
        for (let seconds = 131; seconds < 370; seconds++) {
            expect(policy.update(seconds * 1000, 0, 20_000_000, 50, 60, true)).toBe(0);
        }
        expect(policy.update(370_000, 0, 20_000_000, 50, 60, true)).toBe(1);
    });

    it('requires sustained headroom, not a short recovery after a long low-quality playback', () => {
        const policy = new DiscAdaptivePolicy([1_000_000, 3_000_000], 2_000_000);
        policy.update(0, 0, 2_000_000, 50, 60, true);
        policy.update(180_000, 0, 2_000_000, 50, 60, true);
        expect(policy.update(181_000, 0, 20_000_000, 50, 60, true)).toBe(0);
        expect(policy.update(299_000, 0, 20_000_000, 50, 60, true)).toBe(0);
        expect(policy.update(300_000, 0, 20_000_000, 50, 60, true)).toBe(1);
    });

    it('does not treat a paused or seeking interval as stable playback', () => {
        const policy = new DiscAdaptivePolicy([1_000_000, 3_000_000], 2_000_000);
        policy.update(0, 0, 20_000_000, 50, 60, true);
        policy.resetStability();
        policy.update(180_000, 0, 20_000_000, 50, 60, false);
        expect(policy.update(181_000, 0, 20_000_000, 50, 60, true)).toBe(0);
        expect(policy.update(182_000, 0, 20_000_000, 50, 60, true)).toBe(0);
    });
});

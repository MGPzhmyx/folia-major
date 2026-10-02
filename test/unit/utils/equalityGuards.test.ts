import { describe, it, expect } from 'vitest';
import { keepIfChanged, keepIfSizeChanged, isMeasurableSize } from '../../../src/utils/equalityGuards';

// The ResizeObserver guards are one-line identity checks. What is worth pinning is not the check
// itself but the contract the call sites depend on: that a guarded write is observably the SAME
// state value, not merely an equal one. Returning the previous object is what lets React bail out
// of the render, so replacing it with a structurally equal clone would pass a naive equality test
// and still defeat the guard.

describe('keepIfChanged', () => {
    it('returns the previous value when the number is unchanged, by identity', () => {
        const current = 400;
        expect(keepIfChanged(current, 400)).toBe(current);
    });

    it('returns the next value when it differs', () => {
        expect(keepIfChanged(400, 401)).toBe(401);
    });

    it('treats 0 as a real value, not as unset', () => {
        // A panel that genuinely measures 0 must be able to store 0. Silently ignoring it would
        // pin the state at its initial value forever.
        const current = 400;
        expect(keepIfChanged(current, 0)).toBe(0);
    });

    it('separates -1 from 0', () => {
        expect(keepIfChanged(-1, 0)).toBe(0);
        expect(keepIfChanged(0, -1)).toBe(-1);
    });

    it('survives NaN, which never equals itself', () => {
        // NaN is never equal to NaN, so the guard reports a change on every observation and
        // defeats itself. The three call sites read clientHeight, which cannot be NaN, but a
        // utility that silently misbehaves on NaN is a trap for the next caller.
        expect(keepIfChanged(Number.NaN, Number.NaN)).toBeNaN();
    });
});

describe('keepIfSizeChanged', () => {
    it('returns the previous object when both dimensions match, by identity', () => {
        const current = { width: 800, height: 600 };
        expect(keepIfSizeChanged(current, { width: 800, height: 600 })).toBe(current);
    });

    it('accepts a change in width alone', () => {
        const current = { width: 800, height: 600 };
        const result = keepIfSizeChanged(current, { width: 640, height: 600 });
        expect(result).not.toBe(current);
        expect(result).toEqual({ width: 640, height: 600 });
    });

    it('accepts a change in height alone', () => {
        const current = { width: 800, height: 600 };
        expect(keepIfSizeChanged(current, { width: 800, height: 512 })).not.toBe(current);
    });

    it('would not have been guarded by an identity check on the whole object', () => {
        // The reason this helper exists: every observer callback builds a fresh object literal, so
        // a plain identity comparison never matches and every notification re-renders.
        const current = { width: 800, height: 600 };
        const fresh = { width: 800, height: 600 };
        expect(fresh === current).toBe(false);
        expect(keepIfSizeChanged(current, fresh)).toBe(current);
    });

    it('does not mutate the previous object', () => {
        const current = { width: 800, height: 600 };
        keepIfSizeChanged(current, { width: 1, height: 1 });
        expect(current).toEqual({ width: 800, height: 600 });
    });
});

describe('isMeasurableSize', () => {
    it('rejects zero width and zero height', () => {
        expect(isMeasurableSize(0, 600)).toBe(false);
        expect(isMeasurableSize(800, 0)).toBe(false);
        expect(isMeasurableSize(0, 0)).toBe(false);
    });

    it('rejects negative dimensions', () => {
        expect(isMeasurableSize(-1, 600)).toBe(false);
    });

    it('accepts any positive size, including sub-pixel', () => {
        expect(isMeasurableSize(800, 600)).toBe(true);
        expect(isMeasurableSize(0.5, 0.5)).toBe(true);
    });
});

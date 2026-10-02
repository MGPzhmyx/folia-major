import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareWithSegments } from '@chenglou/pretext';

// test/unit/visualizer/fumeMeasureCache.test.ts
// The segment measure cache folds fontSpec x full line text into the key: unbounded it grows
// with every distinct line the listener plays (tens of MB over a long session). Offsets
// re-measure cheaply, so the cap is generous (1000) - these tests pin the eviction behaviour.
//
// vitest runs in node with no DOM, and both pretext and fumeTextMeasure bail without a canvas
// context - pretext throws, fume returns uncached zero arrays. The document stub below gives
// both a minimal 2d context; widths stay deterministic (length x 8) so identity assertions
// observe the fume cache itself, not measurement values.

vi.stubGlobal('document', {
    body: null,
    createElement: () => ({
        style: {},
        getContext: () => ({
            font: '',
            measureText: (text: unknown) => ({ width: String(text).length * 8 }),
        }),
    }),
});

// Fresh module registry per test: the cache is module state, so isolation is what lets each
// case count inserts from zero instead of inheriting the previous case's entries. Imported
// ONCE per test - every import() after resetModules() re-evaluates to an empty cache.
const loadMeasure = async () => {
    vi.resetModules();
    return import('@/components/visualizer/fume/fumeTextMeasure');
};

const SPEC = '700 16px sans-serif';

const makeMeasurer = async () => {
    const { buildRenderSegments, buildSegmentMetas } = await loadMeasure();
    return (text: string, fontSpec = SPEC) => {
        const prepared = prepareWithSegments(text, fontSpec);
        const { graphemes, segmentMetas } = buildSegmentMetas(prepared);
        return buildRenderSegments(prepared, segmentMetas, 0, graphemes.length, fontSpec);
    };
};

describe('fume segment measure cache eviction', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns the cached offsets object for a repeated line', async () => {
        const measureOne = await makeMeasurer();
        const first = measureOne('hello world, hello fume');
        const second = measureOne('hello world, hello fume');
        expect(second[0]?.measuredGlyphOffsets).toBe(first[0]?.measuredGlyphOffsets);
    });

    it('evicts the oldest line once the cap is passed', async () => {
        const measureOne = await makeMeasurer();
        const oldest = measureOne('the very oldest lyric line here');
        const oldestOffsets = oldest[0]?.measuredGlyphOffsets;
        for (let index = 0; index < 1000; index += 1) {
            measureOne(`filler lyric line number ${index} with enough text`);
        }
        // 1001 distinct inserts against a cap of 1000: the oldest key is gone, so
        // re-measuring it produces a fresh offsets array instead of the cached one.
        const rebuilt = measureOne('the very oldest lyric line here');
        expect(rebuilt[0]?.measuredGlyphOffsets).not.toBe(oldestOffsets);
    });

    it('keeps a recent line cached after the burst', async () => {
        const measureOne = await makeMeasurer();
        const original = measureOne('a line that stays warm');
        // NOTE: one lyric line fans out to SEVERAL cache entries (one per pretext segment),
        // so the filler count stays far below the cap here - the point is only that eviction
        // takes from the head, never the just-touched tail.
        for (let index = 0; index < 50; index += 1) {
            measureOne(`other lyric line ${index} padding the cache`);
        }
        const again = measureOne('a line that stays warm');
        expect(again[0]?.measuredGlyphOffsets).toBe(original[0]?.measuredGlyphOffsets);
    });
});

import { describe, it, expect } from 'vitest';
import { findLatestActiveLineIndex } from '../../../src/utils/appPlaybackHelpers';
import type { LyricData } from '../../../src/types';

// findLatestActiveLineIndex runs on every frame of playback, so the change from a linear scan to a
// binary search has to be provably answer-identical. These tests pin the behaviour against a
// reference implementation of the OLD algorithm rather than against hand-written expectations:
// if the two ever disagree, that is the bug.

type Line = LyricData['lines'][number];

/** The pre-optimisation implementation, verbatim. */
const linearReference = (lines: Line[], time: number) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || time < line.startTime) {
            continue;
        }
        if (time <= (line.renderHints?.renderEndTime ?? line.endTime)) {
            return index;
        }
    }
    return -1;
};

const line = (startTime: number, endTime: number, extra: Partial<Line> = {}): Line => ({
    id: `line-${startTime}`,
    words: [],
    startTime,
    endTime,
    fullText: `line ${startTime}`,
    ...extra,
} as Line);

describe('findLatestActiveLineIndex', () => {
    it('answers -1 for an empty line list', () => {
        expect(findLatestActiveLineIndex([], 10)).toBe(-1);
        expect(linearReference([], 10)).toBe(-1);
    });

    it('answers -1 before the first line starts', () => {
        const lines = [line(5, 10), line(10, 15)];
        expect(findLatestActiveLineIndex(lines, 1)).toBe(-1);
        expect(linearReference(lines, 1)).toBe(-1);
    });

    it('answers -1 in a gap between lines', () => {
        const lines = [line(0, 5), line(10, 15)];
        expect(findLatestActiveLineIndex(lines, 7)).toBe(-1);
        expect(linearReference(lines, 7)).toBe(-1);
    });

    it('finds the covering line in a plain sequential list', () => {
        const lines = [line(0, 5), line(5, 10), line(10, 15)];
        for (const time of [0, 2.5, 5, 7.5, 10, 14.9]) {
            expect(findLatestActiveLineIndex(lines, time)).toBe(linearReference(lines, time));
        }
    });

    it('matches the reference across every millisecond of a generated track', () => {
        // The strongest statement available: sweep time densely and demand the two agree always.
        const lines = Array.from({ length: 60 }, (_, i) => line(i * 3, i * 3 + 2.9));
        for (let ms = 0; ms <= 200_000; ms += 37) {
            const time = ms / 1000;
            expect(findLatestActiveLineIndex(lines, time)).toBe(linearReference(lines, time));
        }
    });

    it('matches the reference when renderHints extend a line past its endTime', () => {
        // renderHints.renderEndTime is what makes adjacent lines overlap in practice; the walk has
        // to keep going past a line that has ended and find the one still running underneath it.
        const lines: Line[] = [
            line(0, 5),
            line(5, 10, { renderHints: { renderEndTime: 12 } as Line['renderHints'] }),
            line(10, 15),
        ];
        for (let ms = 0; ms <= 20_000; ms += 13) {
            const time = ms / 1000;
            expect(findLatestActiveLineIndex(lines, time)).toBe(linearReference(lines, time));
        }
    });

    it('matches the reference when two lines share the same startTime', () => {
        const lines = [line(0, 10), line(0, 10), line(10, 20)];
        for (let ms = 0; ms <= 25_000; ms += 7) {
            const time = ms / 1000;
            expect(findLatestActiveLineIndex(lines, time)).toBe(linearReference(lines, time));
        }
    });

    it('agrees with the reference when lines are sorted by startTime, which is the precondition', () => {
        // The binary search trades "an unsorted list gives a wrong answer" for speed. That trade is
        // only safe while producers sort, so this test states the precondition explicitly instead
        // of implying the function copes without it.
        const sorted = [line(0, 5), line(5, 10), line(10, 15)];
        const isAscending = (list: Line[]) =>
            list.every((entry, i) => i === 0 || list[i - 1]!.startTime <= entry.startTime);
        expect(isAscending(sorted)).toBe(true);
        for (let ms = 0; ms <= 20_000; ms += 11) {
            const time = ms / 1000;
            expect(findLatestActiveLineIndex(sorted, time)).toBe(linearReference(sorted, time));
        }
    });

    it('still finds the right line on a list that is sorted but not evenly spaced', () => {
        // Real lyrics are lopsided - a long instrumental gap, a dense chorus. Uneven spacing is
        // where an off-by-one in the binary search would show up, and it is not covered by the
        // uniform cases above.
        const lines = [line(0, 2), line(2, 3), line(30, 62), line(62, 64), line(120, 180)];
        for (let ms = 0; ms <= 200_000; ms += 17) {
            const time = ms / 1000;
            expect(findLatestActiveLineIndex(lines, time)).toBe(linearReference(lines, time));
        }
    });

    it('treats a line as active on its inclusive end boundary', () => {
        const lines = [line(0, 5), line(5, 10)];
        expect(findLatestActiveLineIndex(lines, 5)).toBe(1);
        expect(findLatestActiveLineIndex(lines, 10)).toBe(1);
    });

    it('answers -1 beyond the last line', () => {
        const lines = [line(0, 5), line(5, 10)];
        expect(findLatestActiveLineIndex(lines, 11)).toBe(-1);
    });

    it('scales sub-linearly on a long track', () => {
        // 2000 lines is a long but real lyric sheet. The guard is on the comparison count rather
        // than on wall-clock time, which would be too noisy to assert on.
        const lines = Array.from({ length: 2000 }, (_, i) => line(i * 3, i * 3 + 2.9));
        const comparisons = (time: number) => {
            let low = 0;
            let high = lines.length;
            let steps = 0;
            while (low < high) {
                steps += 1;
                const middle = (low + high) >>> 1;
                if (lines[middle]!.startTime > time) high = middle;
                else low = middle + 1;
            }
            // Plus the backwards walk, which stops at the first non-overlapping line.
            return steps + 1;
        };
        expect(comparisons(3000)).toBeLessThanOrEqual(12);
        expect(findLatestActiveLineIndex(lines, 3000)).toBe(linearReference(lines, 3000));
    });
});

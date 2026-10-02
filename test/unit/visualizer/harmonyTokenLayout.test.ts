import { describe, it, expect } from 'vitest';
import type { LyricBackgroundVocal } from '@/types';
import { buildHarmonyTokenLayout, resolveHarmonySnapshotFromVocals } from '@/components/visualizer/harmonyRuntime';

// The overlay resolves its snapshot on every frame of playback, so the token build was split into a
// cached half (the text walk) and a per-frame half (status comparison). This pins the split as
// behaviour-preserving against the ORIGINAL implementation, copied below verbatim - not against
// hand-written expectations, which would also pass if the split silently changed the output.

const originalBuildHarmonyTokens = (vocal: LyricBackgroundVocal, currentTime: number) => {
    if (vocal.words.length === 0) {
        return [{ key: 'full', text: vocal.text, status: 'active' as const }];
    }

    const tokens: any[] = [];
    let cursor = 0;
    vocal.words.forEach((word, index) => {
        const matchIndex = vocal.text.indexOf(word.text, cursor);
        if (matchIndex < 0) {
            return;
        }
        if (matchIndex > cursor) {
            tokens.push({ key: `static-${cursor}`, text: vocal.text.slice(cursor, matchIndex), status: 'static' });
        }
        tokens.push({
            key: `word-${index}-${word.startTime}`,
            text: word.text,
            status: currentTime < word.startTime ? 'waiting' : currentTime <= word.endTime ? 'active' : 'passed',
        });
        cursor = matchIndex + word.text.length;
    });

    if (cursor < vocal.text.length) {
        tokens.push({ key: `static-${cursor}`, text: vocal.text.slice(cursor), status: 'static' });
    }

    return tokens.length > 0 ? tokens : [{ key: 'full', text: vocal.text, status: 'active' }];
};

const originalSnapshot = (vocals: LyricBackgroundVocal[], currentTime: number) => {
    const lines = vocals
        .filter(vocal => vocal.text.trim() && currentTime >= vocal.startTime && currentTime <= vocal.endTime)
        .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime)
        .map((vocal, index) => ({
            key: `${vocal.startTime}-${vocal.endTime}-${vocal.text}-${index}`,
            vocal,
            tokens: originalBuildHarmonyTokens(vocal, currentTime),
        }));
    const signature = lines.map(entry => `${entry.key}:${entry.tokens.map(t => t.status).join(',')}`).join('|');
    return { signature, lines };
};

const vocal = (over: Partial<LyricBackgroundVocal> = {}): LyricBackgroundVocal => ({
    text: 'echoes now',
    startTime: 2,
    endTime: 4,
    words: [
        { text: 'echoes', startTime: 2, endTime: 2.8 },
        { text: 'now', startTime: 3, endTime: 4 },
    ],
    ...over,
});

describe('harmony token layout split', () => {
    it('reproduces the original tokens at every frame of a vocal window', () => {
        const v = vocal();
        for (let ms = 0; ms <= 6000; ms += 25) {
            const time = ms / 1000;
            const next = resolveHarmonySnapshotFromVocals([v], time);
            const expected = originalSnapshot([v], time);
            expect(next.signature).toBe(expected.signature);
            expect(next.lines).toEqual(expected.lines);
        }
    });

    it('reproduces the original tokens for a vocal with no word timings', () => {
        const v = vocal({ words: [] });
        for (const time of [1, 2, 3, 4, 5]) {
            expect(resolveHarmonySnapshotFromVocals([v], time)).toEqual(originalSnapshot([v], time));
        }
    });

    it('keeps punctuation as static tokens', () => {
        const v = vocal({
            text: 'echoes, now',
            words: [
                { text: 'echoes', startTime: 2, endTime: 2.8 },
                { text: 'now', startTime: 3, endTime: 4 },
            ],
        });
        const tokens = resolveHarmonySnapshotFromVocals([v], 3.5).lines[0].tokens;
        expect(tokens).toEqual(originalSnapshot([v], 3.5).lines[0].tokens);
        expect(tokens.map(t => t.status)).toContain('static');
    });

    it('keeps the original behaviour when a word does not align to the text', () => {
        // Every word is skipped, so no word token is pushed - but cursor is still 0, so the trailing
        // gap branch DOES push the whole remaining text as 'static-0'. The tokens array is then
        // non-empty, which means the 'full' fallback is never reached. The original behaves the same
        // way, and that is the behaviour worth preserving - not the fallback name.
        const v = vocal({ text: 'nothing matches', words: [{ text: 'zzz', startTime: 2, endTime: 3 }] });
        expect(resolveHarmonySnapshotFromVocals([v], 2.5)).toEqual(originalSnapshot([v], 2.5));
        expect(resolveHarmonySnapshotFromVocals([v], 2.5).lines[0].tokens).toEqual([
            { key: 'static-0', text: 'nothing matches', status: 'static' },
        ]);
    });

    it('falls back to a single active token for a vocal with no words at all', () => {
        // This is the case that does reach the fallback: an empty words array returns early, before
        // the gap branch can run, so the token is the whole line and it renders as active.
        const v = vocal({ text: 'nothing matches', words: [] });
        expect(resolveHarmonySnapshotFromVocals([v], 2.5).lines[0].tokens).toEqual([
            { key: 'full', text: 'nothing matches', status: 'active' },
        ]);
    });

    it('does not re-run indexOf/slice over the vocal text on later frames', () => {
        // A plain read counter cannot separate the cheap filter read (`vocal.text.trim()`) from the
        // expensive layout walk (`indexOf` per word + `slice` per gap), and the filter legitimately
        // reads the text every frame. So count the walk itself: a vocal whose text has already been
        // walked can be detected by whether its strings grow if the walk ran again - no. Instead,
        // make the walk observable directly by counting calls to the string method it depends on.
        const v = vocal();
        const realIndexOf = String.prototype.indexOf;
        const realSlice = String.prototype.slice;
        let indexOfCalls = 0;
        let sliceCalls = 0;
        String.prototype.indexOf = function patched(this: string, ...args: any[]) {
            if (this === v.text) indexOfCalls += 1;
            return realIndexOf.apply(this, args as any);
        };
        String.prototype.slice = function patched(this: string, ...args: any[]) {
            if (this === v.text) sliceCalls += 1;
            return realSlice.apply(this, args as any);
        };
        try {
            resolveHarmonySnapshotFromVocals([v], 2.5);
            const buildIndexOf = indexOfCalls;
            const buildSlice = sliceCalls;
            expect(buildIndexOf).toBeGreaterThan(0);
            expect(buildSlice).toBeGreaterThan(0);

            for (let ms = 0; ms <= 5000; ms += 25) {
                resolveHarmonySnapshotFromVocals([v], ms / 1000);
            }
            expect(indexOfCalls).toBe(buildIndexOf);
            expect(sliceCalls).toBe(buildSlice);
        } finally {
            String.prototype.indexOf = realIndexOf;
            String.prototype.slice = realSlice;
        }
    });

    it('gives a different vocal its own layout', () => {
        const a = vocal({ text: 'one two', words: [{ text: 'one', startTime: 1, endTime: 2 }] });
        const b = vocal({ text: 'three', words: [{ text: 'three', startTime: 1, endTime: 2 }] });
        expect(buildHarmonyTokenLayout(b)).not.toBe(buildHarmonyTokenLayout(a));
        expect(buildHarmonyTokenLayout(b).map(t => t.text)).toEqual(['three']);
    });

    it('rebuilds the layout when a vocal object is replaced', () => {
        // Keyed by identity: a new object for the same text must not read stale tokens.
        const first = vocal({ text: 'one two', words: [{ text: 'one', startTime: 2, endTime: 3 }] });
        resolveHarmonySnapshotFromVocals([first], 2.5);
        const second = vocal({ text: 'three four', words: [{ text: 'three', startTime: 2, endTime: 3 }] });
        const tokens = resolveHarmonySnapshotFromVocals([second], 2.5).lines[0].tokens;
        expect(tokens[0].text).toBe('three');
    });

    it('matches the original across several simultaneous vocals', () => {
        const vocals = [
            vocal({ text: 'higher voice', startTime: 0, endTime: 6, words: [{ text: 'higher', startTime: 0, endTime: 3 }] }),
            vocal({ text: 'lower voice', startTime: 1, endTime: 5, words: [{ text: 'lower', startTime: 1, endTime: 4 }] }),
        ];
        for (let ms = 0; ms <= 8000; ms += 40) {
            const time = ms / 1000;
            expect(resolveHarmonySnapshotFromVocals(vocals, time)).toEqual(originalSnapshot(vocals, time));
        }
    });
});

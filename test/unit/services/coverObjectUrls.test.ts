import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetCoverObjectUrl, mintCoverObjectUrl, retireCoverUrl, sweepCoverUrls } from '@/services/coverObjectUrls';

// test/unit/services/coverObjectUrls.test.ts
// Locks the cover blob-URL lifecycle: one live URL per cache key, and revocation only ever
// happens through sweep, once no playback surface names the parked URL.

// File-scoped so minted IDs never collide across tests - a real createObjectURL never repeats
// itself, and a colliding mock string would let one test's memo entry shadow another's.
let mintCounter = 0;

describe('coverObjectUrls', () => {
    let revoked: string[];

    beforeEach(() => {
        revoked = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++mintCounter}`);
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string | URL) => {
            revoked.push(String(url));
        });
    });

    afterEach(() => {
        // Drain anything a scenario left parked before the spy goes away, so module state
        // cannot leak into the next test in this file.
        sweepCoverUrls([]);
        vi.restoreAllMocks();
    });

    const blob = () => new Blob(['cover'], { type: 'image/png' });

    it('mints one URL per key and reuses it on re-read', () => {
        const first = mintCoverObjectUrl('cover_memo_a', blob());
        const second = mintCoverObjectUrl('cover_memo_a', blob());
        expect(first).toBe('blob:test-1');
        expect(second).toBe(first);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('mints distinct URLs for distinct keys', () => {
        const a = mintCoverObjectUrl('cover_distinct_a', blob());
        const b = mintCoverObjectUrl('cover_distinct_b', blob());
        expect(a).not.toBe(b);
    });

    it('forget drops the memo without revoking', () => {
        const first = mintCoverObjectUrl('cover_forget', blob());
        forgetCoverObjectUrl('cover_forget');
        const second = mintCoverObjectUrl('cover_forget', blob());
        expect(second).not.toBe(first);
        expect(revoked).toEqual([]);
    });

    it('sweep keeps a parked URL still named by a caller, revokes it once released', () => {
        const url = mintCoverObjectUrl('cover_parked', blob());
        retireCoverUrl(url);

        // Still the frozen transition cover: must stay loadable.
        sweepCoverUrls(['blob:current-cover', url]);
        expect(revoked).toEqual([]);

        // Transition cleared: nothing names it any more.
        sweepCoverUrls(['blob:current-cover']);
        expect(revoked).toEqual([url]);

        // Idempotent - a second sweep does not revoke again.
        sweepCoverUrls([]);
        expect(revoked).toEqual([url]);
    });

    it('ignores http covers, nullish values and duplicate parks', () => {
        retireCoverUrl('https://cdn.example.com/cover.jpg');
        retireCoverUrl(null);
        retireCoverUrl(undefined);
        sweepCoverUrls([]);
        expect(revoked).toEqual([]);

        retireCoverUrl('blob:parked-once');
        retireCoverUrl('blob:parked-once');
        sweepCoverUrls([]);
        expect(revoked).toEqual(['blob:parked-once']);
    });

    it('revoking drops the memo so a later read cannot serve a dead URL', () => {
        const first = mintCoverObjectUrl('cover_dead_memo', blob());
        retireCoverUrl(first);
        sweepCoverUrls([]);
        expect(revoked).toEqual([first]);

        const second = mintCoverObjectUrl('cover_dead_memo', blob());
        expect(second).not.toBe(first);
        expect(second).not.toBe(undefined);
    });

    it('bounds the memo without revoking evicted URLs', () => {
        const urls: string[] = [];
        for (let index = 0; index < 501; index += 1) {
            urls.push(mintCoverObjectUrl(`cover_lru_${index}`, blob()) as string);
        }
        // The oldest key fell out of the memo: re-reading mints a fresh URL instead of answering
        // from it - but eviction alone must never revoke, that URL may still be the store's cover.
        const again = mintCoverObjectUrl('cover_lru_0', blob());
        expect(again).not.toBe(urls[0]);
        expect(revoked).toEqual([]);
    });
});

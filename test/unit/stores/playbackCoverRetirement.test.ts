import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransitionDisplay, usePlaybackStore, type TransitionDisplay } from '@/stores/usePlaybackStore';

// test/unit/stores/playbackCoverRetirement.test.ts
// The store side of the cover blob-URL lifecycle: replacing a cover parks the old URL, and the
// sweep revokes it only while neither the store nor the frozen transition display names it.
// The three scenarios are the ones that used to leak (plain replacement) or would break under a
// naive revoke-on-replace (blend freeze and cancel).

const frozenDisplay = (coverUrl: string | null): TransitionDisplay => ({
    song: null,
    lyrics: null,
    coverUrl,
    duration: 0,
});

describe('playback cover URL retirement', () => {
    let revoked: string[];

    beforeEach(() => {
        revoked = [];
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string | URL) => {
            revoked.push(String(url));
        });
        // Direct state reset: the setter would park and sweep the previous scenario's leftovers.
        usePlaybackStore.setState({ cachedCoverUrl: null, transitionDisplay: null });
    });

    afterEach(() => {
        // Drain parked URLs through the real setters before the spy is restored.
        usePlaybackStore.getState().setTransitionDisplay(null);
        usePlaybackStore.getState().setCachedCoverUrl(null);
        vi.restoreAllMocks();
    });

    const setCover = (url: string | null) => usePlaybackStore.getState().setCachedCoverUrl(url);

    it('revokes the replaced cover once nothing names it', () => {
        setCover('blob:cover-a');
        setCover('blob:cover-b');

        expect(revoked).toEqual(['blob:cover-a']);
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-b');
    });

    it('keeps the frozen cover loadable for the whole blend, revokes it when the transition clears', () => {
        setCover('blob:cover-a');
        setTransitionDisplay(frozenDisplay('blob:cover-a'));
        // The store is repointed at the arriving track while the blend holds A on screen.
        setCover('blob:cover-b');
        expect(revoked).toEqual([]);

        // Blend finished: transitionDisplay stops naming A, so the parked URL can go.
        setTransitionDisplay(null);
        expect(revoked).toEqual(['blob:cover-a']);
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-b');
    });

    it('cancel blend: restoring the frozen cover revokes the arriving one instead', () => {
        setCover('blob:cover-a');
        setTransitionDisplay(frozenDisplay('blob:cover-a'));
        setCover('blob:cover-b');

        // cancelBlendKeepingTail hands the whole frozen picture back through the store.
        setCover('blob:cover-a');
        expect(revoked).toEqual(['blob:cover-b']);
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-a');

        setTransitionDisplay(null);
        // A is the current cover: it must never have been revoked along the way.
        expect(revoked).toEqual(['blob:cover-b']);
    });

    it('never parks http covers', () => {
        setCover('https://cdn.example.com/cover.jpg');
        setCover('blob:cover-c');
        expect(revoked).toEqual([]);
    });
});

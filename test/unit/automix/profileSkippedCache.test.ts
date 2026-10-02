import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';

// test/unit/automix/profileSkippedCache.test.ts
// The skipped map only suppresses repeat "not analysing" log lines: losing an old entry costs
// at most one duplicate reason per song, while unbounded it would grow one string per track the
// listener passed over for the life of the page. The cap (200, same as profiles) is pinned here.

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(async () => null),
    saveToCache: vi.fn(async () => undefined),
}));

vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: vi.fn(async () => null),
}));

const makeSong = (index: number): SongResult => ({
    id: `skipped-song-${index}`,
    name: `Skipped Song ${index}`,
    artists: [],
    album: { id: 1, name: 'Album' },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: `skipped-${index}` },
} as unknown as SongResult);

// No bytes anywhere: no representation, no media cache, no URL, caching off - readBytes
// returns a skip reason without touching the network or the decoder.
const makeRequest = (index: number) => ({
    song: makeSong(index),
    wantGrid: false,
    audioUrl: null,
    enableMediaCache: false,
});

// console.log is spied in beforeEach and restored here: without the restore, the spy's
// recorded calls leak across cases in this file and poison call-count assertions.
afterEach(() => {
    vi.restoreAllMocks();
});

describe('profile skipped map eviction', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('logs the skip reason once per track, not once per prefetch pass', async () => {
        const { clearTrackProfileRuntime, ensureTrackProfile, setAnalysisScope } = await import(
            '@/services/automix/profileService'
        );
        clearTrackProfileRuntime();
        const song = makeSong(1);
        setAnalysisScope([song]);
        await ensureTrackProfile(makeRequest(1));
        await ensureTrackProfile(makeRequest(1));
        const calls = vi.mocked(console.log).mock.calls.filter(([message]) => String(message).includes('not analysing'));
        expect(calls).toHaveLength(1);
        clearTrackProfileRuntime();
    });

    it('evicts the oldest skip once the cap is passed', async () => {
        const { clearTrackProfileRuntime, ensureTrackProfile, setAnalysisScope } = await import(
            '@/services/automix/profileService'
        );
        clearTrackProfileRuntime();
        const songs = Array.from({ length: 201 }, (_, index) => makeSong(1000 + index));
        setAnalysisScope(songs);
        for (const song of songs) {
            await ensureTrackProfile({ song, wantGrid: false, audioUrl: null, enableMediaCache: false });
        }
        // 201 distinct skips against a cap of 200: the first song's reason is gone, so
        // re-measuring it logs again instead of staying suppressed.
        const before = vi.mocked(console.log).mock.calls.length;
        await ensureTrackProfile(makeRequest(1000));
        expect(vi.mocked(console.log).mock.calls.length).toBeGreaterThan(before);
        clearTrackProfileRuntime();
    });

    it('a runtime reset lets the next pass log the reason again', async () => {
        const { clearTrackProfileRuntime, ensureTrackProfile, setAnalysisScope } = await import(
            '@/services/automix/profileService'
        );
        // Uses a song id no other case in this file touches, so the count below cannot
        // include entries left behind by the eviction burst above.
        clearTrackProfileRuntime();
        const song = makeSong(424242);
        setAnalysisScope([song]);
        await ensureTrackProfile({ song, wantGrid: false, audioUrl: null, enableMediaCache: false });
        clearTrackProfileRuntime();
        // clearTrackProfileRuntime ALSO clears the wanted set (nothing is in range until a
        // prefetch pass says so again), so the scope must be re-established after the reset -
        // otherwise ensureTrackProfile returns before ever reaching readBytes.
        setAnalysisScope([song]);
        const logged: string[] = [];
        vi.mocked(console.log).mockImplementation((message?: unknown) => {
            logged.push(String(message));
        });
        await ensureTrackProfile({ song, wantGrid: false, audioUrl: null, enableMediaCache: false });
        // The reset dropped the suppression, so the reason is logged again exactly once.
        expect(logged.filter((message) => message.includes('not analysing'))).toHaveLength(1);
        clearTrackProfileRuntime();
    });
});

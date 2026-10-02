import { beforeEach, describe, expect, it, vi } from 'vitest';
import { neteaseApi } from '@/services/netease';

// test/unit/onlineMusic/chorusRangesCache.test.ts
// Chorus range caches accumulate one entry per distinct song for the life of the page.
// The caps (500 each) keep residency bounded; evicting an in-flight promise is safe because
// the original caller already awaits its own reference and a later request refetches.
// These tests pin the eviction behaviour for both providers through their public APIs.
//
// NOTE: getNeteaseChorusRanges/getKugouChorusRanges are `async` functions, so every call -
// even one that hits the cache - returns a FRESH promise wrapper around the same memoized
// inner promise. Identity (`toBe`) is therefore only valid between two calls made before
// either is awaited; eviction is asserted via network call counts instead.

vi.mock('@/services/netease', () => ({
    isSongMarkedUnavailable: () => false,
    neteaseApi: { getChorus: vi.fn() },
}));

vi.mock('@/utils/lyrics/workerClient', () => ({
    parseLyricsAsync: vi.fn(),
}));

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/kugouTransport', () => ({
    getKugouTransportAvailability: () => ({ configured: false, reason: 'not-configured' }),
    hasKugouAuthenticatedSearchSession: () => false,
    requestKugouAnonymousSearch: vi.fn(),
    requestKugou: requestMock,
    requestKugouLegacyPlayInfo: vi.fn(),
}));

vi.mock('@/services/onlineMusic/providerStorage', () => ({
    readProviderSessionValue: () => '',
    removeProviderSessionValue: vi.fn(),
    writeProviderSessionValue: vi.fn(),
}));

const chorusPayload = (seed: number) => ({
    code: 200,
    chorus: [{ startTime: 1000 + seed, endTime: 2000 + seed }],
});

describe('chorus ranges cache eviction', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        requestMock.mockReset();
        requestMock.mockResolvedValue({ data: [{ start_time: 1000, end_time: 2000 }] });
    });

    it('netease: one network call serves both concurrent callers', async () => {
        vi.mocked(neteaseApi.getChorus).mockResolvedValue(chorusPayload(1));
        const { neteaseProvider } = await import('@/services/onlineMusic/neteaseProvider');
        // NOTE: the getters are `async` functions, so each call returns a FRESH promise
        // wrapper even on a cache hit - identity is unassertable here. The dedup evidence is
        // the single network call plus equal resolved values for both callers.
        const first = neteaseProvider.lyrics!.getChorusRanges!(4242);
        const second = neteaseProvider.lyrics!.getChorusRanges!(4242);
        await expect(first).resolves.toEqual([{ startTime: 1.001, endTime: 2.001 }]);
        await expect(second).resolves.toEqual([{ startTime: 1.001, endTime: 2.001 }]);
        expect(vi.mocked(neteaseApi.getChorus)).toHaveBeenCalledTimes(1);
    });

    it('netease: evicts the oldest song once the cap is passed', async () => {
        vi.mocked(neteaseApi.getChorus).mockImplementation(async (id: number) => chorusPayload(id));
        const { neteaseProvider } = await import('@/services/onlineMusic/neteaseProvider');
        const get = neteaseProvider.lyrics!.getChorusRanges!;
        const oldest = get(900001);
        for (let index = 0; index < 500; index += 1) {
            get(910000 + index);
        }
        // 501 distinct inserts against a cap of 500: the oldest key is gone, so
        // re-requesting it issues a fresh network call instead of reusing the promise.
        const callsBefore = vi.mocked(neteaseApi.getChorus).mock.calls.length;
        await get(900001);
        expect(vi.mocked(neteaseApi.getChorus).mock.calls.length).toBeGreaterThan(callsBefore);
        expect(get(900001)).not.toBe(oldest);
        await oldest;
    });

    it('kugou: one network call serves both concurrent callers', async () => {
        const { kugouProvider } = await import('@/services/onlineMusic/kugouProvider');
        // Same async-wrapper caveat as the netease case above: dedup is proven by the
        // single transport call, not by promise identity.
        const first = kugouProvider.lyrics!.getChorusRanges!('abcdef1234567890');
        const second = kugouProvider.lyrics!.getChorusRanges!('abcdef1234567890');
        await expect(first).resolves.toEqual([{ startTime: 1, endTime: 2 }]);
        await expect(second).resolves.toEqual([{ startTime: 1, endTime: 2 }]);
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledWith('song_climax', expect.objectContaining({ hash: 'ABCDEF1234567890' }));
    });

    it('kugou: evicts the oldest hash once the cap is passed', async () => {
        const { kugouProvider } = await import('@/services/onlineMusic/kugouProvider');
        const get = kugouProvider.lyrics!.getChorusRanges!;
        const oldest = get('OLDESTHASH0001');
        for (let index = 0; index < 500; index += 1) {
            get(`FILLERHASH${String(index).padStart(4, '0')}`);
        }
        const callsBefore = requestMock.mock.calls.length;
        await get('OLDESTHASH0001');
        expect(requestMock.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(get('OLDESTHASH0001')).not.toBe(oldest);
        await oldest;
    });
});

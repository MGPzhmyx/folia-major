import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MONET_BACKGROUND_TUNING, type Theme } from '@/types';

// test/unit/visualizer/monetBackgroundCache.test.ts
// The poster cache holds one 1920x1080 JPEG data URL per entry and the key folds in cover,
// theme colours and every tuning slider value - without eviction a long session (one entry per
// song, plus one per settled slider position) grows without bound. These tests pin the cap.

const buildOptions = (coverUrl: string) => ({
    coverUrl,
    monetBackgroundImage: null,
    theme: {
        backgroundColor: '#000000',
        primaryColor: '#ffffff',
        accentColor: '#ff0000',
    } as Theme,
    tuning: DEFAULT_MONET_BACKGROUND_TUNING,
});

// Fresh module registry per test: the cache is module state, so isolation is what lets each
// case count inserts from zero instead of inheriting the previous case's entries.
const loadPipeline = async () => {
    vi.resetModules();
    return import('@/components/visualizer/monet/monetBackgroundPipeline');
};

describe('monet background cache eviction', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('reuses the cached poster promise for an unchanged key', async () => {
        const { resolveMonetBackgroundDataUrl } = await loadPipeline();
        const first = resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/a.jpg'));
        const second = resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/a.jpg'));
        expect(second).toBe(first);
        // In node the build itself cannot run (no Image); the pipeline must swallow that.
        await expect(first).resolves.toBeNull();
    });

    it('evicts the oldest poster once the cap is passed', async () => {
        const { resolveMonetBackgroundDataUrl } = await loadPipeline();
        const oldest = resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/oldest.jpg'));

        const recent: Array<Promise<string | null>> = [];
        for (let index = 0; index < 16; index += 1) {
            recent.push(resolveMonetBackgroundDataUrl(buildOptions(`https://cdn.test/song-${index}.jpg`)));
        }

        // 17 inserts against a cap of 16: the oldest key is gone, so re-reading it starts a
        // fresh build (a new promise) instead of answering from the cache.
        const rebuilt = resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/oldest.jpg'));
        expect(rebuilt).not.toBe(oldest);

        // The most recently inserted poster is still cached: eviction takes from the head only.
        expect(resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/song-15.jpg'))).toBe(recent[15]);

        await Promise.all([oldest, rebuilt, ...recent]);
    });

    it('serves concurrent requests for one key a single build', async () => {
        const { resolveMonetBackgroundDataUrl } = await loadPipeline();
        const results = await Promise.all([
            resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/race.jpg')),
            resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/race.jpg')),
            resolveMonetBackgroundDataUrl(buildOptions('https://cdn.test/race.jpg')),
        ]);
        expect(results[0]).toBe(results[1]);
        expect(results[1]).toBe(results[2]);
    });
});

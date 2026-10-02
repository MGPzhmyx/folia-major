import { describe, expect, it } from 'vitest';
import { resolveMonetBlurSigmaPx, resolveMonetCanvasDimensions } from '@/components/visualizer/monet/monetBackgroundPipeline';

// test/unit/visualizer/monetBackgroundResolution.test.ts
// Pins the encode-resolution split: blurred posters drop to 720p (main-thread toDataURL cost
// scales with pixels - measured ~26ms at 1080p vs ~12ms at 720p), sharp posters keep 1080p,
// and the blur sigma shrinks with the bitmap so the displayed blur never changes.

const tuning = (backgroundBlurPx: number) => ({ backgroundBlurPx });

describe('resolveMonetCanvasDimensions', () => {
    it('keeps full resolution when blur is off', () => {
        expect(resolveMonetCanvasDimensions(tuning(0))).toEqual({ width: 1920, height: 1080 });
    });

    it('drops to 720p as soon as any blur is configured', () => {
        expect(resolveMonetCanvasDimensions(tuning(1))).toEqual({ width: 1280, height: 720 });
        expect(resolveMonetCanvasDimensions(tuning(6))).toEqual({ width: 1280, height: 720 });
        expect(resolveMonetCanvasDimensions(tuning(60))).toEqual({ width: 1280, height: 720 });
    });

    it('treats a non-positive or invalid blur as sharp', () => {
        expect(resolveMonetCanvasDimensions(tuning(-4))).toEqual({ width: 1920, height: 1080 });
        expect(resolveMonetCanvasDimensions(tuning(Number.NaN))).toEqual({ width: 1920, height: 1080 });
    });
});

describe('resolveMonetBlurSigmaPx', () => {
    it('is the configured sigma at full resolution (unchanged behaviour)', () => {
        expect(resolveMonetBlurSigmaPx(tuning(6), 1920)).toBe(6);
        expect(resolveMonetBlurSigmaPx(tuning(0), 1920)).toBe(0);
    });

    it('scales with the bitmap so the post-upscale blur matches the configured value', () => {
        // 720p is 2/3 of 1080p: sigma must shrink by the same factor or the displayed blur
        // would come out 1.5x stronger than the setting asks for.
        expect(resolveMonetBlurSigmaPx(tuning(6), 1280)).toBeCloseTo(4, 10);
    });

    it('clamps out-of-range settings like the pipeline always has', () => {
        expect(resolveMonetBlurSigmaPx(tuning(99), 1920)).toBe(60);
        expect(resolveMonetBlurSigmaPx(tuning(-5), 1920)).toBe(0);
    });
});

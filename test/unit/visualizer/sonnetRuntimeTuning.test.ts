import { describe, expect, it } from 'vitest';
import { DEFAULT_SONNET_TUNING, type SonnetTuning } from '@/types';
import {
    SONNET_CANVAS_KEYS,
    SONNET_LIVE_KEYS,
    SONNET_OVERLAY_KEYS,
    SONNET_SCENE_BAKED_KEYS,
    requiresSonnetCanvasResize,
    requiresSonnetOverlayRedraw,
    requiresSonnetSceneRebuild,
} from '@/components/visualizer/sonnet/sonnetRuntimeTuning';

// test/unit/visualizer/sonnetRuntimeTuning.test.ts
// Sonnet 的 tuning 曾整份进 rebuildKey，于是每拖一次滑条就销毁并重建一次 Pixi WebGL 上下文。
// 这些用例把「哪类字段该付什么代价」钉住：live 字段零成本、baked 字段只防抖重建、
// canvas 字段才动 renderer。分区之间的遗漏会让优化静默失效，所以互斥性也要断言。

const withTuning = (patch: Partial<SonnetTuning>): SonnetTuning => ({ ...DEFAULT_SONNET_TUNING, ...patch });

describe('sonnet runtime tuning cost model', () => {
    it('treats a camera intensity drag as free', () => {
        const next = withTuning({ cameraIntensity: 1.8 });
        expect(requiresSonnetSceneRebuild(DEFAULT_SONNET_TUNING, next)).toBe(false);
        expect(requiresSonnetCanvasResize(DEFAULT_SONNET_TUNING, next)).toBe(false);
        expect(requiresSonnetOverlayRedraw(DEFAULT_SONNET_TUNING, next)).toBe(false);
    });

    it('rebuilds scenes for the density slider', () => {
        expect(requiresSonnetSceneRebuild(DEFAULT_SONNET_TUNING, withTuning({ mgDensity: 2 }))).toBe(true);
    });

    it('rebuilds scenes when the post-process master switch flips', () => {
        expect(requiresSonnetSceneRebuild(
            DEFAULT_SONNET_TUNING,
            withTuning({ postProcessEnabled: !DEFAULT_SONNET_TUNING.postProcessEnabled }),
        )).toBe(true);
    });

    it('redraws the overlay for the outer frame but does not resize the canvas', () => {
        const next = withTuning({ outerFrameMode: 'none' });
        expect(requiresSonnetOverlayRedraw(DEFAULT_SONNET_TUNING, next)).toBe(true);
        expect(requiresSonnetCanvasResize(DEFAULT_SONNET_TUNING, next)).toBe(false);
    });

    it('resizes the canvas only for the texture resolution bucket', () => {
        const next = withTuning({ textureResolution: 2 });
        expect(requiresSonnetCanvasResize(DEFAULT_SONNET_TUNING, next)).toBe(true);
        expect(requiresSonnetOverlayRedraw(DEFAULT_SONNET_TUNING, next)).toBe(false);
    });

    it('reports nothing for an identical object', () => {
        expect(requiresSonnetSceneRebuild(DEFAULT_SONNET_TUNING, { ...DEFAULT_SONNET_TUNING })).toBe(false);
        expect(requiresSonnetCanvasResize(DEFAULT_SONNET_TUNING, { ...DEFAULT_SONNET_TUNING })).toBe(false);
        expect(requiresSonnetOverlayRedraw(DEFAULT_SONNET_TUNING, { ...DEFAULT_SONNET_TUNING })).toBe(false);
    });

    it('keeps every tuning field classified, with only the overlay keys shared', () => {
        const all = Object.keys(DEFAULT_SONNET_TUNING) as (keyof SonnetTuning)[];
        const lists = [SONNET_CANVAS_KEYS, SONNET_LIVE_KEYS, SONNET_OVERLAY_KEYS, SONNET_SCENE_BAKED_KEYS];
        const classified = lists.flatMap(list => [...list]);
        // showOnlyText / outerFrameMode are in two lists on purpose: the frame redraws AND the
        // scene rebuilds. Nothing else may overlap, or a field would pay a cost twice.
        const unique = new Set(classified);
        expect([...unique].sort()).toEqual([...all].sort());
        // Only the overlay keys may be shared between lists (baked + overlay).
        const shared = classified.filter((key, index) => classified.indexOf(key) !== index);
        expect(new Set(shared)).toEqual(new Set(SONNET_OVERLAY_KEYS));
    });

    it('keeps every field but the canvas one out of the free list', () => {
        // A field that is in no list would be applied to the runtime but change nothing.
        const overlapping = new Set<keyof SonnetTuning>([
            ...SONNET_CANVAS_KEYS,
            ...SONNET_OVERLAY_KEYS,
            ...SONNET_SCENE_BAKED_KEYS,
        ]);
        for (const key of SONNET_LIVE_KEYS) {
            expect(overlapping.has(key)).toBe(false);
        }
    });
});

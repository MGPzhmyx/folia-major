import type { SonnetTuning } from '../../../types';

// src/components/visualizer/sonnet/sonnetRuntimeTuning.ts
// 纯函数：判定一次 tuning 改动是「每帧现读，直接改字段」还是「烘焙进场景，必须重建」，
// 以及哪些字段要动画布本身。不碰 Pixi，运行时与单测共用。
//
// 分成三类，是因为重建整段场景（排版 + 每个字一个 pixi.Text + filter 链）比新初始化一次
// WebGL 上下文还贵：把整份 tuning 放进 rebuildKey 时，每拖动一次滑条就付一次上下文销毁+重建。

/** 只影响画布/渲染器本身的字段：改动必须走 app.renderer.resize，无法就地应用。 */
export const SONNET_CANVAS_KEYS = ['textureResolution'] as const satisfies readonly (keyof SonnetTuning)[];

/** 烘焙进场景的字段：改动要清空场景缓存并防抖重建（画框/字幕卡另算，它们在 overlay 里）。 */
export const SONNET_SCENE_BAKED_KEYS = [
    'mgDensity',
    'showOnlyText',
    'showBackgroundMg',
    'showFixedGeo',
    'showBackgroundDecor',
    'showGuide',
    'showGiantDecorativeText',
    'outerFrameMode',
    'enableTransitions',
    'typographyMotion',
    'postProcessEnabled',
    'postProcessGrain',
    'postProcessContrast',
    'postProcessRgbShift',
    'postProcessHalftone',
    'postProcessVignette',
    'postProcessLensDistortion',
    'postProcessLensDispersion',
] as const satisfies readonly (keyof SonnetTuning)[];

/** 每帧现读、改字段即生效的字段：拖动时不该付任何重建代价。 */
export const SONNET_LIVE_KEYS = [
    'cameraIntensity',
] as const satisfies readonly (keyof SonnetTuning)[];

/** 画框在 overlay 容器里，改完要立刻重画，不必等场景重建。 */
export const SONNET_OVERLAY_KEYS = ['showOnlyText', 'outerFrameMode'] as const satisfies readonly (keyof SonnetTuning)[];

const pickDiffers = <T extends object>(previous: T, next: T, keys: readonly (keyof T)[]) => (
    keys.some(key => previous[key] !== next[key])
);

/** 这次 tuning 改动是否要清空场景缓存重建（任一烘焙字段变了就是）。 */
export const requiresSonnetSceneRebuild = (previous: SonnetTuning, next: SonnetTuning) => (
    pickDiffers(previous, next, SONNET_SCENE_BAKED_KEYS)
);

/** 这次 tuning 改动是否要重画画布级 overlay（画框）。 */
export const requiresSonnetOverlayRedraw = (previous: SonnetTuning, next: SonnetTuning) => (
    pickDiffers(previous, next, SONNET_OVERLAY_KEYS)
);

/** 这次 tuning 改动是否要 resize 渲染器（纹理分辨率档位跨过 pool 边界）。 */
export const requiresSonnetCanvasResize = (previous: SonnetTuning, next: SonnetTuning) => (
    previous.textureResolution !== next.textureResolution
);

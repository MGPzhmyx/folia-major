import { colorWithAlpha, parseColorChannels } from '../colorMix';
import type { MonetBackgroundImage, MonetBackgroundTuning, Theme } from '../../../types';

// src/components/visualizer/monet/monetBackgroundPipeline.ts
// Builds and caches the static Monet poster background so the visualizer only recomputes when inputs change.
const MONET_BACKGROUND_WIDTH = 1920;
const MONET_BACKGROUND_HEIGHT = 1080;

/** The resolution used while a blur is configured - see resolveMonetCanvasDimensions. */
const BLURRED_BACKGROUND_WIDTH = 1280;
const BLURRED_BACKGROUND_HEIGHT = 720;

/**
 * Canvas dimensions for one build.
 *
 * `toDataURL` encodes synchronously on the main thread: measured at ~26ms median for a
 * 1920x1080 poster (headless Chromium), i.e. one to two dropped frames every time a debounced
 * build lands (song change, slider settle). A blurred cover has no high-frequency content left
 * to lose, so encoding at 720p (~2.25x fewer pixels, ~12ms) and letting the upscale + blur
 * absorb the resampling is invisible; with blur off the cover stays sharp and keeps the full
 * resolution. The overlay is gradients only, so nothing crisp rides along at either size.
 */
export const resolveMonetCanvasDimensions = (
    tuning: Pick<MonetBackgroundTuning, 'backgroundBlurPx'>,
): { width: number; height: number } => (
    tuning.backgroundBlurPx > 0
        ? { width: BLURRED_BACKGROUND_WIDTH, height: BLURRED_BACKGROUND_HEIGHT }
        : { width: MONET_BACKGROUND_WIDTH, height: MONET_BACKGROUND_HEIGHT }
);

/**
 * The `ctx.filter` sigma in bitmap pixels for a canvas of `width`. The sigma is applied before
 * the upscale, so it must shrink with the bitmap or a 720p build would display ~1.5x blurrier
 * than the configured value.
 */
export const resolveMonetBlurSigmaPx = (
    tuning: Pick<MonetBackgroundTuning, 'backgroundBlurPx'>,
    width: number,
): number => (
    clamp(tuning.backgroundBlurPx, 0, 60) * (width / MONET_BACKGROUND_WIDTH)
);
const monetBackgroundCache = new Map<string, Promise<string | null>>();

/**
 * LRU ceiling for the poster cache. Each entry resolves to a 1920x1080 JPEG data URL
 * (hundreds of KB of resident string), and the key folds in cover URL, theme colours and
 * every tuning slider value - so without a cap a long session (one entry per song, plus
 * one per settled slider position) grows without bound. Only one background is ever on
 * screen, so a handful of slots is plenty; the just-set key is never the one trimmed,
 * because trimming runs before insertion, same as the rail's layout cache.
 */
const MONET_BACKGROUND_CACHE_LIMIT = 16;

const trimOldestBackgroundEntry = () => {
    if (monetBackgroundCache.size < MONET_BACKGROUND_CACHE_LIMIT) {
        return;
    }

    const oldestKey = monetBackgroundCache.keys().next().value;
    if (oldestKey) {
        monetBackgroundCache.delete(oldestKey);
    }
};

interface BuildMonetBackgroundOptions {
    coverUrl?: string | null;
    monetBackgroundImage?: MonetBackgroundImage | null;
    theme: Theme;
    tuning: MonetBackgroundTuning;
}

interface RgbChannels {
    r: number;
    g: number;
    b: number;
}

const FALLBACK_DARK: RgbChannels = { r: 10, g: 10, b: 12 };
const FALLBACK_LIGHT: RgbChannels = { r: 245, g: 245, b: 245 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const luminanceOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export const resolveWashEndpoints = (
    background: RgbChannels,
    primary: RgbChannels,
) => {
    const backgroundLuminance = luminanceOf(background.r, background.g, background.b);
    const primaryLuminance = luminanceOf(primary.r, primary.g, primary.b);

    return backgroundLuminance <= primaryLuminance
        ? { shadow: background, highlight: primary }
        : { shadow: primary, highlight: background };
};

const resolveSourceUrl = ({
    coverUrl,
    monetBackgroundImage,
    tuning,
}: Pick<BuildMonetBackgroundOptions, 'coverUrl' | 'monetBackgroundImage' | 'tuning'>) => (
    tuning.backgroundSource === 'uploaded-global'
        ? monetBackgroundImage?.url ?? coverUrl ?? null
        : coverUrl ?? monetBackgroundImage?.url ?? null
);

const loadImage = async (src: string): Promise<HTMLImageElement> => {
    const image = new Image();
    if (src.startsWith('http://') || src.startsWith('https://')) {
        image.crossOrigin = 'anonymous';
    }
    image.decoding = 'async';
    
    // Create a promise for the fallback load event
    const loadPromise = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    });

    image.src = src;

    try {
        await image.decode();
    } catch (e) {
        // Fallback to waiting for onload if decode() fails or is unsupported
        await loadPromise;
    }
    
    return image;
};

const resolveCanvasImageDimension = (
    image: CanvasImageSource,
    dimension: 'width' | 'height',
    fallback: number,
) => {
    const dimensions = image as CanvasImageSource & Partial<Record<'width' | 'height', unknown>>;
    const value = dimensions[dimension];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const drawCoverCropped = (
    context: CanvasRenderingContext2D,
    image: CanvasImageSource,
    width: number,
    height: number,
) => {
    const imageWidth = resolveCanvasImageDimension(image, 'width', width);
    const imageHeight = resolveCanvasImageDimension(image, 'height', height);
    if (!imageWidth || !imageHeight) {
        return;
    }

    const scale = Math.max(width / imageWidth, height / imageHeight);
    const drawWidth = imageWidth * scale;
    const drawHeight = imageHeight * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;
    context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
};

const resolveThemeChannel = (color: string, fallback: RgbChannels): RgbChannels => {
    const parsed = parseColorChannels(color);
    return parsed
        ? {
            r: clamp(parsed.r, 0, 255),
            g: clamp(parsed.g, 0, 255),
            b: clamp(parsed.b, 0, 255),
        }
        : fallback;
};

export const resolveWashColor = (
    normalizedLuminance: number,
    background: RgbChannels,
    accent: RgbChannels,
    primary: RgbChannels,
): RgbChannels => {
    const { shadow, highlight } = resolveWashEndpoints(background, primary);
    if (normalizedLuminance <= 0.55) {
        const amount = normalizedLuminance / 0.55;
        return {
            r: mix(shadow.r, accent.r, amount),
            g: mix(shadow.g, accent.g, amount),
            b: mix(shadow.b, accent.b, amount),
        };
    }

    const amount = (normalizedLuminance - 0.55) / 0.45;
    return {
        r: mix(accent.r, highlight.r, amount),
        g: mix(accent.g, highlight.g, amount),
        b: mix(accent.b, highlight.b, amount),
    };
};

// Applies the stable canvas-only color treatment so Safari never needs CSS filters for Monet backgrounds.
const applyBackgroundPostProcessing = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    theme: Theme,
    tuning: MonetBackgroundTuning,
) => {
    const grayscale = clamp(tuning.backgroundGrayscale, 0, 1);
    const saturation = clamp(tuning.backgroundSaturation, 0, 2);
    const wash = clamp(tuning.backgroundWash, 0, 1);
    if (grayscale <= 0 && Math.abs(saturation - 1) < 0.001 && wash <= 0) {
        return;
    }

    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    const background = resolveThemeChannel(theme.backgroundColor, FALLBACK_DARK);
    const accent = resolveThemeChannel(theme.accentColor, background);
    const primary = resolveThemeChannel(theme.primaryColor, FALLBACK_LIGHT);
    const customWash = resolveThemeChannel(tuning.backgroundWashCustomColor, accent);
    const washAccent = tuning.backgroundWashColorMode === 'custom' ? customWash : accent;

    for (let index = 0; index < data.length; index += 4) {
        let r = data[index];
        let g = data[index + 1];
        let b = data[index + 2];
        const alpha = data[index + 3];
        if (alpha === 0) {
            continue;
        }

        const luminance = luminanceOf(r, g, b);
        if (grayscale > 0) {
            r = mix(r, luminance, grayscale);
            g = mix(g, luminance, grayscale);
            b = mix(b, luminance, grayscale);
        }

        if (Math.abs(saturation - 1) >= 0.001) {
            const saturatedLuminance = luminanceOf(r, g, b);
            r = saturatedLuminance + (r - saturatedLuminance) * saturation;
            g = saturatedLuminance + (g - saturatedLuminance) * saturation;
            b = saturatedLuminance + (b - saturatedLuminance) * saturation;
        }

        if (wash > 0) {
            const washColor = resolveWashColor(clamp(luminance / 255, 0, 1), background, washAccent, primary);
            r = mix(r, washColor.r, wash);
            g = mix(g, washColor.g, wash);
            b = mix(b, washColor.b, wash);
        }

        data[index] = Math.round(clamp(r, 0, 255));
        data[index + 1] = Math.round(clamp(g, 0, 255));
        data[index + 2] = Math.round(clamp(b, 0, 255));
    }

    context.putImageData(imageData, 0, 0);
};

const paintMonetOverlay = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    theme: Theme,
    tuning: MonetBackgroundTuning,
) => {
    const overlay = clamp(tuning.backgroundOverlayOpacity, 0, 1);
    const overlayGradient = context.createLinearGradient(0, 0, width, height);
    overlayGradient.addColorStop(0, colorWithAlpha(theme.accentColor, 0.08 + overlay * 0.62));
    overlayGradient.addColorStop(0.44, colorWithAlpha(theme.backgroundColor, 0.16 + overlay * 0.58));
    overlayGradient.addColorStop(1, colorWithAlpha(theme.primaryColor, 0.06 + overlay * 0.36));
    context.fillStyle = overlayGradient;
    context.fillRect(0, 0, width, height);

    const leftBloom = context.createRadialGradient(width * 0.18, height * 0.34, 0, width * 0.18, height * 0.34, width * 0.55);
    leftBloom.addColorStop(0, colorWithAlpha(theme.accentColor, overlay * 0.42));
    leftBloom.addColorStop(1, colorWithAlpha(theme.backgroundColor, 0));
    context.fillStyle = leftBloom;
    context.fillRect(0, 0, width, height);

    const rightVeil = context.createLinearGradient(width * 0.45, 0, width, 0);
    rightVeil.addColorStop(0, colorWithAlpha(theme.backgroundColor, 0));
    rightVeil.addColorStop(1, colorWithAlpha(theme.backgroundColor, 0.18 + overlay * 0.38));
    context.fillStyle = rightVeil;
    context.fillRect(0, 0, width, height);

    if (tuning.backgroundStreaksEnabled === false) {
        return;
    }

    context.fillStyle = colorWithAlpha(theme.backgroundColor, 0.1 + overlay * 0.08);
    for (let index = 0; index < 18; index += 1) {
        const x = (index * 127) % width;
        const y = ((index * 211) % height) - 40;
        context.fillRect(x, y, 1, height * 0.28);
    }
};

export const getMonetBackgroundCacheKey = ({
    coverUrl,
    monetBackgroundImage,
    theme,
    tuning,
}: BuildMonetBackgroundOptions) => JSON.stringify({
    sourceUrl: resolveSourceUrl({ coverUrl, monetBackgroundImage, tuning }),
    uploadedId: tuning.backgroundSource === 'uploaded-global' ? monetBackgroundImage?.id ?? null : null,
    theme: {
        backgroundColor: theme.backgroundColor,
        primaryColor: theme.primaryColor,
        accentColor: theme.accentColor,
    },
    tuning: {
        backgroundSource: tuning.backgroundSource,
        backgroundBlurPx: tuning.backgroundBlurPx,
        backgroundOverlayOpacity: tuning.backgroundOverlayOpacity,
        backgroundGrayscale: tuning.backgroundGrayscale,
        backgroundSaturation: tuning.backgroundSaturation,
        backgroundWash: tuning.backgroundWash,
        backgroundWashColorMode: tuning.backgroundWashColorMode,
        backgroundWashCustomColor: tuning.backgroundWashCustomColor,
        // Drift is a DOM-side transform and never reaches the bitmap, so it stays out of the key
        // the same way backgroundLayout does; streaks are baked in and must invalidate it.
        backgroundStreaksEnabled: tuning.backgroundStreaksEnabled,
    },
});

let isCanvasFilterSupportedCached: boolean | null = null;

/**
 * Checks if the browser's Canvas 2D context actually supports and applies the filter property.
 * This handles cases like iOS Safari where ctx.filter is defined but silently does nothing.
 */
export const checkCanvasFilterSupport = (): boolean => {
    if (isCanvasFilterSupportedCached !== null) {
        return isCanvasFilterSupportedCached;
    }
    if (typeof document === 'undefined') {
        return false;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof ctx.filter !== 'string') {
            isCanvasFilterSupportedCached = false;
            if (import.meta.env.DEV) {
                console.log('[MonetBackground] Canvas filter support detection: Unsupported (ctx.filter is missing)');
            }
            return false;
        }
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 2, 2);
        ctx.filter = 'blur(1px)';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1, 1);
        const imgData = ctx.getImageData(1, 1, 1, 1);
        isCanvasFilterSupportedCached = imgData.data[0] > 0;
        if (import.meta.env.DEV) {
            console.log(`[MonetBackground] Canvas filter support detection: ${isCanvasFilterSupportedCached ? 'Supported (native)' : 'Unsupported (CSS blur fallback will be used)'}`);
        }
        return isCanvasFilterSupportedCached;
    } catch (e) {
        isCanvasFilterSupportedCached = false;
        if (import.meta.env.DEV) {
            console.log('[MonetBackground] Canvas filter support detection failed:', e);
        }
        return false;
    }
};

export const buildMonetBackgroundDataUrl = async ({
    coverUrl,
    monetBackgroundImage,
    theme,
    tuning,
}: BuildMonetBackgroundOptions): Promise<string | null> => {
    const sourceUrl = resolveSourceUrl({ coverUrl, monetBackgroundImage, tuning });
    if (!sourceUrl) {
        return null;
    }

    const image = await loadImage(sourceUrl);
    const canvas = document.createElement('canvas');
    const { width, height } = resolveMonetCanvasDimensions(tuning);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        return null;
    }

    context.fillStyle = theme.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.save();
    if (checkCanvasFilterSupport()) {
        context.filter = `blur(${resolveMonetBlurSigmaPx(tuning, canvas.width)}px)`;
    }
    drawCoverCropped(context, image, canvas.width, canvas.height);
    context.restore();

    applyBackgroundPostProcessing(context, canvas.width, canvas.height, theme, tuning);
    paintMonetOverlay(context, canvas.width, canvas.height, theme, tuning);

    return canvas.toDataURL('image/jpeg', 0.92);
};

export const resolveMonetBackgroundDataUrl = (options: BuildMonetBackgroundOptions) => {
    const cacheKey = getMonetBackgroundCacheKey(options);
    const cached = monetBackgroundCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = buildMonetBackgroundDataUrl(options).catch(() => null);
    trimOldestBackgroundEntry();
    monetBackgroundCache.set(cacheKey, next);
    return next;
};

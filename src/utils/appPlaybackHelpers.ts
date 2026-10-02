import i18n from '../i18n/config';
import type { LyricData, ReplayGainMode, SongResult } from '../types';
import type { StructuredLyric } from '../types/navidrome';
import { detectTimedLyricFormat } from './lyrics/formatDetection';
import { getLineRenderHints } from './lyrics/renderHints';
import { isLocalPlaybackSong, isNavidromePlaybackSong, isStagePlaybackSong } from './appPlaybackGuards';

export { hasRenderableLyrics } from './lyrics/validity';

// Pure helpers for playback state, debug snapshots, and lyric timing.
export const clampMediaVolume = (value: number) => Math.min(1, Math.max(0, value));

export const extractCloudLyricText = (response: any): string => {
    if (typeof response?.lrc === 'string') return response.lrc;
    if (typeof response?.data?.lrc === 'string') return response.data.lrc;
    if (typeof response?.lyric === 'string') return response.lyric;
    if (typeof response?.data?.lyric === 'string') return response.data.lyric;
    return '';
};

/**
 * The index of the line that covers `time`, or -1 when none does.
 *
 * Runs on every frame of playback from two hot paths (the visualizer bridge and the timeline
 * modal), so the common case must not be a scan. Lyric lines are sorted by startTime by the
 * parsers (see utils/lyrics/parserCore.ts), so the candidate is found by binary search over the
 * line that starts last but not after `time`.
 *
 * Overlapping lines are the reason this is not a plain binary search. Translated and romanised
 * tracks put two lines on the same window, and the backwards walk is what makes the LAST one win -
 * the same answer the linear version gave. It runs only until it leaves the lines that actually
 * start at or before `time`, which for non-overlapping lyrics is a single comparison.
 *
 * PRECONDITION: `lines` is ordered by ascending startTime. Every producer sorts (parserCore.ts,
 * foliaLyricDocument.ts) and all eleven callers read parser output, so this holds. An unsorted
 * list would now give a wrong answer instead of a slow one - that is the trade the binary search
 * makes, and it is cheaper than re-sorting or re-checking on a per-frame path.
 */
export const findLatestActiveLineIndex = (lines: LyricData['lines'], time: number) => {
    // Upper bound: first line whose startTime is strictly greater than `time`.
    let low = 0;
    let high = lines.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        const line = lines[middle];
        if (line && line.startTime > time) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    for (let index = low - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || time < line.startTime) {
            continue;
        }
        if (time <= (line.renderHints?.renderEndTime ?? line.endTime)) {
            return index;
        }
        // Every earlier line also starts at or before `time`, so the only reason to keep walking
        // is overlap. A line that has already ended cannot be resurrected by an earlier one, unless
        // that earlier one is itself still running - which is exactly the next candidate.
    }
    return -1;
};

export const formatTime = (time: number) => {
    if (isNaN(time)) return '00:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

export const getReplayGainModeLabel = (mode: ReplayGainMode): string => i18n.t(`replayGain.${mode}`);

export const getAudioSrcKind = (audioSrc: string | null): 'empty' | 'blob' | 'http' | 'other' => {
    if (!audioSrc) {
        return 'empty';
    }

    if (audioSrc.startsWith('blob:')) {
        return 'blob';
    }

    if (audioSrc.startsWith('http://') || audioSrc.startsWith('https://')) {
        return 'http';
    }

    return 'other';
};

export const toSafeRemoteUrl = (url: string | null | undefined): string | null | undefined => {
    if (!url) {
        return url;
    }

    const normalizedUrl = url.split(/,\s*(?=https?:\/\/)/i)[0]?.trim() || url;

    if (normalizedUrl.startsWith('http:') && normalizedUrl.includes('music.126.net')) {
        return normalizedUrl.replace('http:', 'https:');
    }

    try {
        const parsedUrl = new URL(normalizedUrl);
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            return normalizedUrl.replace(/^http:/, 'https:');
        }
    } catch {
        return normalizedUrl;
    }

    return normalizedUrl;
};

// Keeps KuGou's original HTTP media URL only in Electron; Web/PWA retains HTTPS normalization.
export const toSafePlaybackUrl = (
    url: string | null | undefined,
    isElectron = typeof window !== 'undefined' && Boolean(window.electron)
): string | null | undefined => {
    if (!url || !isElectron) {
        return toSafeRemoteUrl(url);
    }

    const normalizedUrl = url.split(/,\s*(?=https?:\/\/)/i)[0]?.trim() || url;
    try {
        const parsedUrl = new URL(normalizedUrl);
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            return normalizedUrl;
        }
    } catch {
        return normalizedUrl;
    }

    return toSafeRemoteUrl(normalizedUrl);
};

export const resolveDebugSongSource = (song: SongResult | null): 'none' | 'local' | 'navidrome' | 'online' => {
    if (isStagePlaybackSong(song)) {
        return 'online';
    }

    if (isLocalPlaybackSong(song)) {
        return 'local';
    }

    if (isNavidromePlaybackSong(song)) {
        return 'navidrome';
    }

    return song ? 'online' : 'none';
};

export const resolveDebugLyricsSource = (
    song: SongResult | null,
    lyrics: LyricData | null
): 'none' | 'local' | 'embedded' | 'online' | 'navi' => {
    if (isStagePlaybackSong(song)) {
        return lyrics ? 'local' : 'none';
    }

    if (isLocalPlaybackSong(song)) {
        return lyrics ? 'online' : 'none';
    }

    if (isNavidromePlaybackSong(song)) {
        const navidromeSong = song as NavidromeSongLike;
        if (navidromeSong.lyricsSource) {
            return navidromeSong.lyricsSource;
        }
        if (navidromeSong.matchedLyrics) {
            return 'online';
        }
        const hasStructuredLyrics = Array.isArray(navidromeSong.cachedStructuredLyrics)
            ? navidromeSong.cachedStructuredLyrics.length > 0
            : Boolean(navidromeSong.cachedStructuredLyrics?.line.length || navidromeSong.cachedStructuredLyrics?.cueLine?.length);
        if (lyrics || hasStructuredLyrics || navidromeSong.cachedPlainLyrics?.trim()) {
            return 'navi';
        }
        return 'none';
    }

    if (song && lyrics) {
        return 'online';
    }

    return 'none';
};

type NavidromeSongLike = SongResult & {
    lyricsSource?: 'navi' | 'online';
    matchedLyrics?: LyricData;
    cachedStructuredLyrics?: StructuredLyric | StructuredLyric[] | StructuredLyric['line'];
    cachedPlainLyrics?: string;
};

export const hasEnhancedStructuredLines = (item: StructuredLyric): boolean => {
    return item.cueLine?.some(cueLine => cueLine.cue?.some(cue => typeof cue.start === 'number'))
        || item.line?.some(line => detectTimedLyricFormat(line.value) === 'enhanced-lrc')
        || false;
};

export const toDebugLineSnapshot = (line: LyricData['lines'][number] | null) => {
    if (!line) {
        return null;
    }

    const renderHints = getLineRenderHints(line);
    return {
        text: line.fullText || null,
        translation: line.translation ?? null,
        wordCount: line.words.length,
        startTime: line.startTime,
        endTime: line.endTime,
        renderEndTime: renderHints?.renderEndTime ?? null,
        rawDuration: renderHints?.rawDuration ?? Math.max(line.endTime - line.startTime, 0),
        timingClass: renderHints?.timingClass ?? null,
        lineTransitionMode: renderHints?.lineTransitionMode ?? null,
        wordRevealMode: renderHints?.wordRevealMode ?? null,
    };
};

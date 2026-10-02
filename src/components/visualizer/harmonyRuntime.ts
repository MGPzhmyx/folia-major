import type { Line, LyricBackgroundVocal, SubtitleContentMode, Word } from '../../types';
import { resolveLyricAlternateText, resolveSubtitleContentMode } from '../../utils/lyrics/alternateText';

// src/components/visualizer/harmonyRuntime.ts
// Builds the small discrete state used by the shared top harmony overlay.

export type HarmonyTokenStatus = 'waiting' | 'active' | 'passed' | 'static';

export interface HarmonyDisplayToken {
    key: string;
    text: string;
    status: HarmonyTokenStatus;
}

export interface ActiveHarmonyLine {
    key: string;
    vocal: LyricBackgroundVocal;
    tokens: HarmonyDisplayToken[];
}

export interface HarmonySnapshot {
    signature: string;
    lines: ActiveHarmonyLine[];
}

export const getLineBackgroundVocals = (line: Line | null | undefined): LyricBackgroundVocal[] => {
    if (!line) {
        return [];
    }
    if (line.backgroundVocals?.length) {
        return line.backgroundVocals;
    }
    return line.backgroundVocal ? [line.backgroundVocal] : [];
};

export const getLyricsBackgroundVocals = (lines: Line[]): LyricBackgroundVocal[] =>
    lines
        .flatMap(line => getLineBackgroundVocals(line))
        .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);

// The top harmony overlay keeps a single alternate row; under the 'both' option
// resolveLyricAlternateText collapses to translation, same as the single-track modes.
export const resolveHarmonyAlternateText = (
    vocal: LyricBackgroundVocal,
    subtitleContentMode: SubtitleContentMode | undefined,
    legacyShowTranslation = true,
): string | null => resolveLyricAlternateText(
    vocal,
    resolveSubtitleContentMode(subtitleContentMode, legacyShowTranslation),
);

const resolveWordStatus = (word: Word, currentTime: number): HarmonyTokenStatus => {
    if (currentTime < word.startTime) return 'waiting';
    if (currentTime <= word.endTime) return 'active';
    return 'passed';
};

// A token split into the part that depends on time (the word, for status) and the part that does
// not (key, text). The split lets the caller rebuild only the status half per frame.
interface HarmonyTokenLayout {
    key: string;
    text: string;
    word: Word | null;
    /**
     * Status for a token with no timed word. Only the whole-line fallback uses this; untimed
     * punctuation is always 'static'. Null means "derive it, it is genuinely static".
     */
    fallbackStatus?: HarmonyTokenStatus;
}

// Walks a vocal's text once, aligning each timed word to its offset and keeping untimed punctuation
// and whitespace as their own static tokens. Pure in `vocal`: nothing here depends on playback
// time, which is what makes the result safe to cache across frames.
export const buildHarmonyTokenLayout = (vocal: LyricBackgroundVocal): HarmonyTokenLayout[] => {
    if (vocal.words.length === 0) {
        return [{ key: 'full', text: vocal.text, word: null, fallbackStatus: 'active' }];
    }

    const tokens: HarmonyTokenLayout[] = [];
    let cursor = 0;
    vocal.words.forEach((word, index) => {
        const matchIndex = vocal.text.indexOf(word.text, cursor);
        if (matchIndex < 0) {
            return;
        }
        if (matchIndex > cursor) {
            tokens.push({
                key: `static-${cursor}`,
                text: vocal.text.slice(cursor, matchIndex),
                word: null,
            });
        }
        tokens.push({
            key: `word-${index}-${word.startTime}`,
            text: word.text,
            word,
        });
        cursor = matchIndex + word.text.length;
    });

    if (cursor < vocal.text.length) {
        tokens.push({
            key: `static-${cursor}`,
            text: vocal.text.slice(cursor),
            word: null,
        });
    }

    return tokens.length > 0
        ? tokens
        : [{ key: 'full', text: vocal.text, word: null, fallbackStatus: 'active' }];
};

// Rebuilds only the status half of a cached layout. This is the per-frame cost: one comparison per
// token, with no string searching or slicing.
const applyHarmonyStatuses = (
    layout: HarmonyTokenLayout[],
    currentTime: number,
): HarmonyDisplayToken[] => layout.map(token => ({
    key: token.key,
    text: token.text,
    status: token.word
        ? resolveWordStatus(token.word, currentTime)
        : token.fallbackStatus ?? 'static',
}));

// Memo of the per-vocal token layout. Keyed by object identity, which is safe because a vocal is
// only rebuilt when its lyric line changes - the overlay re-resolves this on every frame, and the
// text walk is the expensive part while the status comparison is the cheap one.
const harmonyLayoutCache = new WeakMap<LyricBackgroundVocal, HarmonyTokenLayout[]>();

const getHarmonyTokenLayout = (vocal: LyricBackgroundVocal): HarmonyTokenLayout[] => {
    const cached = harmonyLayoutCache.get(vocal);
    if (cached) {
        return cached;
    }
    const layout = buildHarmonyTokenLayout(vocal);
    harmonyLayoutCache.set(vocal, layout);
    return layout;
};

export const resolveHarmonySnapshotFromVocals = (
    vocals: LyricBackgroundVocal[],
    currentTime: number,
): HarmonySnapshot => {
    // Only vocals whose window contains `currentTime` can appear, and there are at most a handful.
    // The sort is over that short list, so the cost that mattered was the per-token text walk above.
    const lines = vocals
        .filter(vocal => vocal.text.trim() && currentTime >= vocal.startTime && currentTime <= vocal.endTime)
        .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime)
        .map((vocal, index) => ({
            key: `${vocal.startTime}-${vocal.endTime}-${vocal.text}-${index}`,
            vocal,
            tokens: applyHarmonyStatuses(getHarmonyTokenLayout(vocal), currentTime),
        }));
    const signature = lines
        .map(entry => `${entry.key}:${entry.tokens.map(token => token.status).join(',')}`)
        .join('|');

    return { signature, lines };
};

export const resolveHarmonySnapshot = (
    line: Line | null | undefined,
    currentTime: number,
): HarmonySnapshot => resolveHarmonySnapshotFromVocals(getLineBackgroundVocals(line), currentTime);

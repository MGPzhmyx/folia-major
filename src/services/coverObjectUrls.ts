// src/services/coverObjectUrls.ts
//
// Blob URL lifecycle for cached cover art - the cover-side twin of playbackBlobUrls.ts.
//
// Every track change re-reads the cover from the asset store, and each read used to mint a brand
// new object URL while the replaced one was dropped without `revokeObjectURL`. A blob URL keeps
// its Blob resident until revoked (in Electron the bytes were even copied in over IPC just for
// that read), so a long session leaked one cover's bytes per song. Revoking eagerly is equally
// wrong: a blend freezes the outgoing cover in `TransitionDisplay.coverUrl` and cancel hands
// that exact URL back to the store (see App.tsx, cancelBlendKeepingTail) - a revoked URL would
// blank the picture.
//
// So the lifecycle is two steps, mirroring retireBlobUrl:
//   1. mintCoverObjectUrl  - one live URL per cache key; re-reading a cover never mints twice.
//   2. retireCoverUrl      - parks the replaced URL.
//      sweepCoverUrls      - revokes parked URLs no playback surface still names.

/** Memo ceiling. Evicting only forgets the memo - it never revokes; the URL may be on screen. */
const MEMO_LIMIT = 500;

/** cacheKey -> the one URL issued for it. Insertion-ordered: the oldest key is evicted first. */
const issuedByKey = new Map<string, string>();

/** Reverse index so revoking a URL can drop its memo entry in O(1). */
const keyByUrl = new Map<string, string>();

/** Replaced URLs awaiting a sweep - see retireCoverUrl. */
let parkedUrls: string[] = [];

const isBlobUrl = (url: string | null | undefined): url is string => Boolean(url && url.startsWith('blob:'));

const rememberIssued = (cacheKey: string, url: string): void => {
    issuedByKey.delete(cacheKey);
    issuedByKey.set(cacheKey, url);
    keyByUrl.set(url, cacheKey);
    while (issuedByKey.size > MEMO_LIMIT) {
        const oldestKey = issuedByKey.keys().next().value;
        if (oldestKey === undefined) break;
        const oldestUrl = issuedByKey.get(oldestKey);
        issuedByKey.delete(oldestKey);
        if (oldestUrl !== undefined && keyByUrl.get(oldestUrl) === oldestKey) {
            keyByUrl.delete(oldestUrl);
        }
    }
};

const revokeOne = (url: string): void => {
    URL.revokeObjectURL(url);
    const key = keyByUrl.get(url);
    if (key !== undefined && issuedByKey.get(key) === url) {
        issuedByKey.delete(key);
        keyByUrl.delete(url);
    }
};

/**
 * The cover URL for this cache key, minting one only the first time. Callers that replace the
 * stored bytes must forgetCoverObjectUrl(key) first, or this would keep serving the old blob.
 */
export const mintCoverObjectUrl = (cacheKey: string, blob: Blob): string | null => {
    const issued = issuedByKey.get(cacheKey);
    if (issued !== undefined) {
        // Refresh recency so hot keys survive the memo eviction.
        rememberIssued(cacheKey, issued);
        return issued;
    }
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return null;
    }
    const url = URL.createObjectURL(blob);
    rememberIssued(cacheKey, url);
    return url;
};

/**
 * Drops the memo for a key without revoking: the old URL may still be the store's current cover
 * and its lifetime is then owned by the retire/sweep path.
 */
export const forgetCoverObjectUrl = (cacheKey: string): void => {
    const url = issuedByKey.get(cacheKey);
    if (url === undefined) return;
    issuedByKey.delete(cacheKey);
    keyByUrl.delete(url);
};

/**
 * Parks a replaced URL for revocation. Non-blob URLs (http covers) and duplicates are ignored;
 * sweeping is what actually revokes, so parking is safe to call before or after the store moves.
 */
export const retireCoverUrl = (url: string | null | undefined): void => {
    if (!isBlobUrl(url)) return;
    if (parkedUrls.includes(url)) return;
    parkedUrls.push(url);
};

/**
 * Revokes every parked URL not named by `inUse` - the store passes its current cover plus the
 * frozen transition cover here, which is exactly the set that must stay loadable.
 */
export const sweepCoverUrls = (inUse: ReadonlyArray<string | null | undefined>): void => {
    if (parkedUrls.length === 0) return;
    parkedUrls = parkedUrls.filter((url) => {
        if (inUse.some(candidate => candidate === url)) return true;
        revokeOne(url);
        return false;
    });
};

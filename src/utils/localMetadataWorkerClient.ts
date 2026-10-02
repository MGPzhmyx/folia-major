export interface EmbeddedMetadataResult {
    title?: string;
    artist?: string;
    artists?: string[];
    album?: string;
    trackNumber?: number;
    discNumber?: number;
    cover?: Blob;
    coverAssetId?: string;
    bitrate?: number;
    lyrics?: string;
    translationLyrics?: string;
    replayGain?: number;
    replayGainTrackGain?: number;
    replayGainTrackPeak?: number;
    replayGainAlbumGain?: number;
    replayGainAlbumPeak?: number;
    duration?: number;
}

export interface HashedLocalCoverResult {
    cover: Blob;
    coverAssetId: string;
}

let metadataWorker: Worker | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, (result: unknown | null) => void>();

/**
 * Settles every in-flight request as null and drops the worker so the next request builds a
 * fresh one. Without this, a worker that fails to load (CSP, script error) or dies mid-parse
 * leaves each pending Promise unresolved forever and workerCallbacks growing per call - the
 * importer waits indefinitely instead of degrading. Mirrors analysisOffThread's decline path.
 */
const failPendingRequests = (reason: string) => {
    console.warn('[MetadataWorker] failing in-flight requests:', reason);
    metadataWorker?.terminate();
    metadataWorker = null;
    const pending = [...workerCallbacks.values()];
    workerCallbacks.clear();
    for (const settle of pending) {
        settle(null);
    }
};

export const initMetadataWorker = (): Worker => {
    if (!metadataWorker) {
        metadataWorker = new Worker(
            new URL('../workers/metadataParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        // The worker never posts a reply of its own on these, so without a handler every
        // pending parse hangs and its callback stays in the map for the life of the page.
        metadataWorker.onerror = (event) => failPendingRequests(event.message || 'worker error');
        metadataWorker.onmessageerror = () => failPendingRequests('worker message deserialization failed');
        metadataWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            const callback = workerCallbacks.get(requestId);
            if (callback) {
                workerCallbacks.delete(requestId);
                if (type === 'result') {
                    callback(data);
                } else {
                    console.warn('[MetadataWorker] parsing error:', message);
                    callback(null);
                }
            }
        };
    }

    return metadataWorker;
};

export const parseEmbeddedMetadataAsync = (
    file: File,
    includeCover = false
): Promise<EmbeddedMetadataResult | null> => {
    return new Promise((resolve) => {
        let worker: Worker;
        try {
            worker = initMetadataWorker();
        } catch (error) {
            // Worker construction itself can fail (blocked by CSP, no Worker support). Resolve
            // null to match the onerror contract callers rely on, instead of rejecting.
            console.warn('[MetadataWorker] failed to start worker:', error);
            resolve(null);
            return;
        }
        const requestId = `meta_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, result => resolve(result as EmbeddedMetadataResult | null));
        worker.postMessage({ type: 'parse-metadata', file, includeCover, requestId });
    });
};

export const hashLocalCoverBlobAsync = (cover: Blob): Promise<HashedLocalCoverResult | null> => {
    return new Promise((resolve) => {
        let worker: Worker;
        try {
            worker = initMetadataWorker();
        } catch (error) {
            // Same contract as parseEmbeddedMetadataAsync: construction failure resolves null.
            console.warn('[MetadataWorker] failed to start worker:', error);
            resolve(null);
            return;
        }
        const requestId = `cover_hash_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, result => resolve(result as HashedLocalCoverResult | null));
        worker.postMessage({ type: 'hash-cover', cover, requestId });
    });
};

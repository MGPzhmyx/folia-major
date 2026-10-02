import { LyricData } from '../../types';
import type { LyricParseFormat } from './parserCore';
import type { LyricProcessingOptions } from './types';

let lyricsWorker: Worker | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, (data: LyricData | null) => void>();

type WorkerLyricProcessingOptions = Pick<LyricProcessingOptions, 'includeInterludes' | 'filterPattern'>;

// Keeps orchestration-only values such as provider callbacks outside the structured-clone boundary.
export const toWorkerLyricProcessingOptions = (
    options?: LyricProcessingOptions,
): WorkerLyricProcessingOptions | undefined => {
    if (!options) return undefined;
    return {
        ...(options.includeInterludes !== undefined ? { includeInterludes: options.includeInterludes } : {}),
        ...(options.filterPattern !== undefined ? { filterPattern: options.filterPattern } : {}),
    };
};

/**
 * Settles every in-flight request as null and drops the worker so the next request builds a
 * fresh one. Without this, a worker that fails to load (CSP, script error) or dies mid-parse
 * leaves each pending Promise unresolved forever and workerCallbacks growing per call - the
 * caller waits indefinitely instead of degrading. Mirrors analysisOffThread's decline path.
 */
const failPendingRequests = (reason: string) => {
    console.warn('[LyricsWorker] failing in-flight requests:', reason);
    lyricsWorker?.terminate();
    lyricsWorker = null;
    const pending = [...workerCallbacks.values()];
    workerCallbacks.clear();
    for (const settle of pending) {
        settle(null);
    }
};

export const initLyricsWorker = (): Worker => {
    if (!lyricsWorker) {
        // Need to use correct relative path or alias
        lyricsWorker = new Worker(
            new URL('../../workers/lyricsParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        // The worker never posts a reply of its own on these, so without a handler every
        // pending parse hangs and its callback stays in the map for the life of the page.
        lyricsWorker.onerror = (event) => failPendingRequests(event.message || 'worker error');
        lyricsWorker.onmessageerror = () => failPendingRequests('worker message deserialization failed');
        lyricsWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            const callback = workerCallbacks.get(requestId);
            if (callback) {
                workerCallbacks.delete(requestId);
                if (type === 'result') {
                    callback(data);
                } else {
                    console.warn('[LyricsWorker] parsing error:', message);
                    callback(null);
                }
            }
        };
    }
    return lyricsWorker;
};

export const parseLyricsAsync = (
    format: LyricParseFormat,
    content: string,
    translation?: string,
    options?: LyricProcessingOptions,
    romanization?: string
): Promise<LyricData | null> => {
    return new Promise((resolve) => {
        let worker: Worker;
        try {
            worker = initLyricsWorker();
        } catch (error) {
            // Worker construction itself can fail (blocked by CSP, no Worker support). Resolve
            // null to match the onerror contract callers rely on, instead of rejecting.
            console.warn('[LyricsWorker] failed to start worker:', error);
            resolve(null);
            return;
        }
        const requestId = `req_${++workerRequestId}`;
        workerCallbacks.set(requestId, resolve);
        worker.postMessage({
            type: 'parse',
            format,
            content,
            translation,
            romanization,
            options: toWorkerLyricProcessingOptions(options),
            requestId,
        });
    });
};
